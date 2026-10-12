import "dotenv/config";
import "reflect-metadata";
import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { buildKernelSourceRuntime } from "./app/kernelSourceRuntime";
import { coreErrorHandler } from './app/security/errorHandler';
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
import { registerStudioPreviewRoutes } from './app/routes/studioPreviewRoutes';
import { applyTenantDocumentBranding } from "./app/tenantDocumentBranding";
import { buildTenantPwaManifest, buildTenantServiceWorker } from "./app/tenantPwa";
import {
  createCoreAdminGuard,
  createCoreCors,
  parseAllowedOrigins,
} from "./app/security/coreHttpSecurity";
import { TenantRequest } from "./types/RequestContext";
import { safeErrorMeta } from '@idp/shared';

const app = express();

const isDevelopmentEnv = process.env.NODE_ENV !== "production";
if (String(process.env.CORE_TRUST_PROXY || "").trim().toLowerCase() === "true") {
  app.set("trust proxy", 1);
}
const coreCors = createCoreCors({
  allowedOrigins: parseAllowedOrigins(process.env.CORE_ALLOWED_ORIGINS),
  isDevelopmentEnv,
});
const coreAdminGuard = createCoreAdminGuard(() => process.env.CORE_ADMIN_TOKEN);

// CORS for routes intended to be called cross-origin. Production callers must
// be listed in CORE_ALLOWED_ORIGINS; localhost remains open in development.
app.use(["/api", "/auth", "/admin"], coreCors);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

if (isDevelopmentEnv) {
  app.get("/kernel-source.js", async (_req, res) => {
    try {
      const js = await buildKernelSourceRuntime(__dirname);
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
  const previewAuthGuard = OptionalAuthGuard(AppDataSource, cryptoService, {
    sessionStore: tenantSessionStore, sessionCookieName: CORE_SSO_COOKIE_NAME,
    allowStudioPreview: true,
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

  app.post("/admin/tenants", coreAdminGuard, adminController.createTenant);
  registerStudioPreviewRoutes(app, AppDataSource, cryptoService);

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
      orchestrationController,
      previewAuthGuard
    )
  );

  app.get("/manifest.webmanifest", optionalContextMiddleware, (req: TenantRequest, res) => {
    const manifest = buildTenantPwaManifest(req.tenant);
    if (!manifest) {
      return res.status(404).json({ error: "PWA is not enabled for this tenant" });
    }
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.status(200).json(manifest);
  });

  app.get("/service-worker.js", optionalContextMiddleware, (req: TenantRequest, res) => {
    const source = buildTenantServiceWorker(req.tenant);
    if (!source) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      return res.status(404).send("// PWA is not enabled for this tenant.\n");
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.status(200).send(source);
  });
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
  }, optionalContextMiddleware, optionalAuthGuard, async (req: TenantRequest, res, next) => {
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

  app.all("*", contextMiddleware, previewAuthGuard, dispatcher.handle);

  app.use(coreErrorHandler);

  app.listen(port, () => {
    console.log(`FaaS runtime listening on port ${port}`);
  });
};

bootstrap().catch((error) => {
  console.error("Failed to start server:", safeErrorMeta(error));
  process.exit(1);
});
