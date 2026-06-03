import "dotenv/config";
import "reflect-metadata";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
import { promises as fs } from "fs";
import { transformSync } from "esbuild";
import { AppError } from "./common/AppError";
import { initializeDataSource, AppDataSource } from "./core/datasource";
import { CryptoService } from "./core/security/CryptoService";
import { AdapterFactory } from "./engine/AdapterFactory";
import { SandboxRunner } from "./engine/SandboxRunner";
import { Dispatcher } from "./app/controllers/Dispatcher";
import { AuthGuard, OptionalAuthGuard } from "./app/middleware/AuthGuard";
import { ContextMiddleware, OptionalContextMiddleware } from "./app/middleware/ContextMiddleware";
import { AdminController } from "./app/controllers/AdminController";
import { RegistryController } from "./app/controllers/RegistryController";
import { ModuleController } from "./app/controllers/ModuleController";
import { UIEntityController } from "./app/controllers/UIEntityController";
import { ApiRouter } from "./app/routers/api";
import { TenantAclController } from "./app/controllers/TenantAclController";
import { OrchestrationController } from "./app/controllers/OrchestrationController";
import { MonitoringService } from "./core/monitoring/MonitoringService";
import { TenantSessionStore } from "./core/security/TenantSessionStore";
import { registerAuthSsoRoutes } from "./app/routes/authSsoRoutes";
import { applyTenantDocumentBranding } from "./app/tenantDocumentBranding";
import { TenantRequest } from "./types/RequestContext";

const app = express();

const isDevelopmentEnv = process.env.NODE_ENV !== "production";

const KERNEL_SOURCE_IMPORT_REACT =
  'import React from "https://esm.sh/react@19?dev";';
const KERNEL_SOURCE_IMPORT_REACT_DOM =
  'import { createRoot } from "https://esm.sh/react-dom@19/client?dev";';

const getKernelSourceCandidates = () => {
  const rootDir = path.resolve(__dirname, "..");
  return [
    path.resolve(rootDir, "kernel", "src", "index.ts"),
    path.resolve(rootDir, "src", "kernel", "src", "index.ts"),
  ];
};

const readKernelSourceTs = async (): Promise<string> => {
  const candidates = getKernelSourceCandidates();
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      // continue probing
    }
  }
  throw new Error("Kernel source file not found");
};

const buildKernelSourceRuntime = async (): Promise<string> => {
  const sourceTs = await readKernelSourceTs();
  const patchedSource = sourceTs
    .replace(
      /import\s+React\s+from\s+["']react["'];?/,
      KERNEL_SOURCE_IMPORT_REACT
    )
    .replace(
      /import\s*\{\s*createRoot\s*\}\s*from\s*["']react-dom\/client["'];?/,
      KERNEL_SOURCE_IMPORT_REACT_DOM
    );

  const transformed = transformSync(patchedSource, {
    loader: "ts",
    format: "esm",
    target: "es2020",
    sourcemap: "inline",
    sourcefile: "kernel/src/index.ts",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  });

  return `${transformed.code}\nwindow.Kernel = Kernel;\nwindow.__IDP_KERNEL_BUILD__ = "dev-source";\n`;
};

// CORS for API routes; frontend is proxied so origin is same
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

if (isDevelopmentEnv) {
  app.get("/kernel-source.js", async (_req, res) => {
    try {
      const js = await buildKernelSourceRuntime();
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.status(200).send(js);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build kernel source runtime";
      res.status(500).json({ error: message });
    }
  });
}

app.use("/public", express.static("public"));

// Fallback static (for production build)
app.use(
  express.static(path.resolve(__dirname, "..", "public"), {
    index: false,
  })
);
const port = parseInt(process.env.PORT ?? "3000", 10);

const CORE_SSO_COOKIE_NAME = (process.env.CORE_SSO_COOKIE_NAME || "idp_tenant_session").trim();
const CORE_SSO_STATE_COOKIE_NAME = "idp_tenant_sso_state";
const CORE_SSO_AUTH_BASE_URL = (process.env.CORE_SSO_AUTH_BASE_URL || "").trim();
const CORE_SSO_SCOPE =
  (process.env.CORE_SSO_SCOPE || "").trim() || "openid profile email";
const CORE_SSO_COOKIE_SECURE =
  String(process.env.CORE_SSO_COOKIE_SECURE || "").trim().toLowerCase() === "true" ||
  process.env.NODE_ENV === "production";
const CORE_SSO_COOKIE_SAME_SITE =
  (process.env.CORE_SSO_COOKIE_SAME_SITE || "lax").trim().toLowerCase() === "none"
    ? "none"
    : (process.env.CORE_SSO_COOKIE_SAME_SITE || "lax").trim().toLowerCase() === "strict"
      ? "strict"
      : "lax";
const CORE_SSO_SESSION_TTL_SEC = Math.max(
  300,
  parseInt(process.env.CORE_SSO_SESSION_TTL_SEC || "28800", 10) || 28800,
);
const CORE_REDIS_URL = (process.env.CACHE_REDIS_URL || process.env.REDIS_URL || "").trim();

const ssoEnabled = Boolean(CORE_SSO_AUTH_BASE_URL);

const buildCryptoService = (): CryptoService => {
  const encryptionKey = getKeyFromEnv("ENCRYPTION_KEY", 32);
  const tokenSecret = getKeyFromEnv("TOKEN_SECRET", 32);
  return new CryptoService(encryptionKey, tokenSecret);
};

const getKeyFromEnv = (envName: string, expectedBytes: number): Buffer => {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`${envName} is required`);
  }

  const isHex = /^[a-fA-F0-9]+$/.test(raw) && raw.length === expectedBytes * 2;
  const buffer = isHex ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buffer.length !== expectedBytes) {
    throw new Error(`${envName} must decode to ${expectedBytes} bytes`);
  }
  return buffer;
};

const bootstrap = async () => {
  await initializeDataSource();
  const monitoringService = new MonitoringService();
  monitoringService.start();
  const cryptoService = buildCryptoService();

  const adapterFactory = new AdapterFactory(AppDataSource, cryptoService);
  const sandboxRunner = new SandboxRunner(30_000);
  const adminController = new AdminController(AppDataSource);
  const dispatcher = new Dispatcher(
    AppDataSource,
    adapterFactory,
    sandboxRunner
  );
  const registryController = new RegistryController(AppDataSource);
  const moduleController = new ModuleController(AppDataSource);
  const uiEntityController = new UIEntityController(AppDataSource);
  const tenantAclController = new TenantAclController(AppDataSource);
  const orchestrationController = new OrchestrationController(AppDataSource);
  const tenantSessionStore = new TenantSessionStore({
    redisUrl: CORE_REDIS_URL || undefined,
    ttlSec: CORE_SSO_SESSION_TTL_SEC,
  });

  const contextMiddleware = ContextMiddleware(AppDataSource);
  const optionalContextMiddleware = OptionalContextMiddleware(AppDataSource);
  const authGuard = AuthGuard(AppDataSource, cryptoService, {
    sessionStore: tenantSessionStore,
    sessionCookieName: CORE_SSO_COOKIE_NAME,
  });
  const optionalAuthGuard = OptionalAuthGuard(AppDataSource, cryptoService, {
    sessionStore: tenantSessionStore,
    sessionCookieName: CORE_SSO_COOKIE_NAME,
  });

  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: CORE_SSO_COOKIE_SAME_SITE as "lax" | "none" | "strict",
    secure: CORE_SSO_COOKIE_SECURE,
    path: "/",
    maxAge: CORE_SSO_SESSION_TTL_SEC * 1000,
  };

  const ssoStateCookieOptions = {
    httpOnly: true,
    sameSite: CORE_SSO_COOKIE_SAME_SITE as "lax" | "none" | "strict",
    secure: CORE_SSO_COOKIE_SECURE,
    path: "/",
    maxAge: 10 * 60 * 1000,
  };

  // Monitoring runs out-of-band and must never block request processing.
  app.use(monitoringService.middleware());

  app.post("/admin/tenants", adminController.createTenant);

  registerAuthSsoRoutes({
    app,
    contextMiddleware,
    optionalAuthGuard,
    cryptoService,
    tenantSessionStore,
    ssoEnabled,
    authBaseUrl: CORE_SSO_AUTH_BASE_URL,
    scope: CORE_SSO_SCOPE,
    sessionCookieName: CORE_SSO_COOKIE_NAME,
    stateCookieName: CORE_SSO_STATE_COOKIE_NAME,
    sessionCookieOptions,
    stateCookieOptions: ssoStateCookieOptions,
  });
  app.use(
    "/api",
    ApiRouter(
      contextMiddleware,
      optionalContextMiddleware,
      authGuard,
      registryController,
      moduleController,
      uiEntityController,
      tenantAclController,
      orchestrationController
    )
  );
  // Serve tenant frontend with tenant-specific document metadata.
  app.get("*", (req, _res, next) => {
    const p = req.path.toLowerCase();
    if (
      p.startsWith("/api") ||
      p.startsWith("/auth") ||
      p.startsWith("/admin")
    ) {
      return next("route");
    }
    return next();
  }, optionalContextMiddleware, async (req: TenantRequest, res, next) => {
    try {
      const indexPath = path.resolve(__dirname, "..", "public", "index.html");
      const html = await fs.readFile(indexPath, "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.status(200).send(applyTenantDocumentBranding(html, req.tenant));
    } catch (error) {
      return next(error);
    }
  });

  app.all("*", contextMiddleware, optionalAuthGuard, dispatcher.handle);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const isAppError = err instanceof AppError;
    const status = isAppError ? err.status : 500;
    const payload: Record<string, unknown> = {
      error: err.message,
      ...(isAppError && (err as AppError).code
        ? { code: (err as AppError).code }
        : {}),
    };

    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      payload.stack = err.stack;
    } else if (status >= 500) {
      payload.error = "Internal server error";
    }

    if (!isAppError) {
      console.error("Unhandled error:", err);
    }

    return res.status(status).json(payload);
  });

  app.listen(port, () => {
    console.log(`FaaS runtime listening on port ${port}`);
  });
};

bootstrap().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
