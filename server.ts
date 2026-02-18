import "dotenv/config";
import "reflect-metadata";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
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
import { MonitoringService } from "./core/monitoring/MonitoringService";
import { TenantSessionStore } from "./core/security/TenantSessionStore";
import { registerAuthSsoRoutes } from "./app/routes/authSsoRoutes";

const app = express();

// CORS for API routes; frontend is proxied so origin is same
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));
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
      tenantAclController
    )
  );
  // Serve frontend (IDE) for non-API routes
  app.get("*", (req, res, next) => {
    const p = req.path.toLowerCase();
    if (
      p.startsWith("/api") ||
      p.startsWith("/auth") ||
      p.startsWith("/admin")
    ) {
      return next();
    }
    const indexPath = path.resolve(__dirname, "..", "public", "index.html");
    return res.sendFile(indexPath);
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
