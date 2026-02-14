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
import { AuthController } from "./app/controllers/AuthController";
import { Dispatcher } from "./app/controllers/Dispatcher";
import { AuthGuard, OptionalAuthGuard } from "./app/middleware/AuthGuard";
import { ContextMiddleware, OptionalContextMiddleware } from "./app/middleware/ContextMiddleware";
import { AdminController } from "./app/controllers/AdminController";
import { RegistryController } from "./app/controllers/RegistryController";
import { ModuleController } from "./app/controllers/ModuleController";
import { UIEntityController } from "./app/controllers/UIEntityController";
import { ApiRouter } from "./app/routers/api";
import { TenantAclController } from "./app/controllers/TenantAclController";
import { UIPackage } from "@idp/shared";
import { TenantRequest } from "./types/RequestContext";
import { MonitoringService } from "./core/monitoring/MonitoringService";

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
const LOGIN_PACKAGE_NAME = "@app/login";

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

const renderLoginShell = ({
  allowRegistration,
  useKernel,
  tenantHost,
}: {
  allowRegistration: boolean;
  useKernel: boolean;
  tenantHost: string;
}) => {
  if (useKernel) {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login</title>
    <script src="/bundle.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.__ALLOW_REGISTRATION__ = ${allowRegistration ? "true" : "false"};
      window.__TENANT_HOST__ = ${JSON.stringify(tenantHost)};
      if (window.Kernel) {
        var kernel = new window.Kernel({ registryUrl: "/api/registry-tenant" });
        kernel.boot("${LOGIN_PACKAGE_NAME}");
      } else {
        console.error("Kernel failed to load");
      }
    </script>
  </body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0f1214; color: #e8eaed; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { width: 360px; background: #171a1d; border: 1px solid #2b2f33; border-radius: 12px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.35); }
      h1 { font-size: 20px; margin: 0 0 16px; }
      label { font-size: 12px; color: #9aa0a6; display: block; margin-bottom: 6px; }
      input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2b2f33; background: #0f1214; color: #e8eaed; }
      button { width: 100%; margin-top: 12px; padding: 10px 12px; border-radius: 8px; border: none; background: #1a73e8; color: white; cursor: pointer; }
      button.secondary { background: #2b2f33; }
      .muted { font-size: 12px; color: #9aa0a6; margin-top: 12px; }
      .message { font-size: 12px; margin-top: 12px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Tenant Login</h1>
      <div id="message" class="message"></div>
      <label>Email</label>
      <input id="email" type="email" placeholder="you@example.com" />
      <label style="margin-top:12px;">Password</label>
      <input id="password" type="password" placeholder="••••••••" />
      <button id="loginBtn">Login</button>
      <button id="registerBtn" class="secondary${allowRegistration ? "" : " hidden"}">Register</button>
      <div class="muted${allowRegistration ? "" : " hidden"}">No account? Register for this tenant.</div>
    </div>
    <script>
      const allowRegistration = ${allowRegistration ? "true" : "false"};
      const message = document.getElementById("message");
      const email = document.getElementById("email");
      const password = document.getElementById("password");
      const loginBtn = document.getElementById("loginBtn");
      const registerBtn = document.getElementById("registerBtn");

      const setMessage = (text, isError) => {
        message.textContent = text || "";
        message.style.color = isError ? "#f28b82" : "#81c995";
      };

      const doLogin = async () => {
        setMessage("", false);
        const res = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value, password: password.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(data.error || "Login failed", true);
          return;
        }
        localStorage.setItem("idp_token", data.token);
        setMessage("Logged in. Token stored in localStorage.", false);
      };

      const doRegister = async () => {
        if (!allowRegistration) return;
        setMessage("", false);
        const res = await fetch("/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value, password: password.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(data.error || "Registration failed", true);
          return;
        }
        await doLogin();
      };

      loginBtn.addEventListener("click", doLogin);
      registerBtn.addEventListener("click", doRegister);
    </script>
  </body>
</html>`;
};

const bootstrap = async () => {
  await initializeDataSource();
  const monitoringService = new MonitoringService();
  monitoringService.start();
  const cryptoService = buildCryptoService();

  const adapterFactory = new AdapterFactory(AppDataSource, cryptoService);
  const sandboxRunner = new SandboxRunner(30_000);
  const authController = new AuthController(AppDataSource, cryptoService);
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

  const contextMiddleware = ContextMiddleware(AppDataSource);
  const optionalContextMiddleware = OptionalContextMiddleware(AppDataSource);
  const authGuard = AuthGuard(AppDataSource, cryptoService);
  const optionalAuthGuard = OptionalAuthGuard(AppDataSource, cryptoService);

  // Monitoring runs out-of-band and must never block request processing.
  app.use(monitoringService.middleware());

  app.post("/admin/tenants", adminController.createTenant);
  app.post("/auth/register", contextMiddleware, authController.register);
  app.post("/auth/login", contextMiddleware, authController.login);
  app.get("/auth/config", contextMiddleware, authController.config);

  app.get("/login", contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as unknown as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send("Tenant required");
      }
      const pkgRepo = AppDataSource.getRepository(UIPackage);
      const packages = await pkgRepo.find({
        where: { tenant: { id: tenantReq.tenant.id }, name: LOGIN_PACKAGE_NAME },
        order: { createdAt: "DESC" },
        take: 1,
      });
      const pkg = packages[0] ?? null;
      const hasPublished = Boolean(pkg?.publishedCodeBlob) && Boolean(pkg?.publishedVersion);

      const allowRegistration = tenantReq.tenant.allowRegistration ?? true;
      if (hasPublished) {
        return res.send(
          renderLoginShell({
            allowRegistration,
            useKernel: true,
            tenantHost: tenantReq.tenant.hostname,
          })
        );
      }
      return res.send(
        renderLoginShell({
          allowRegistration,
          useKernel: false,
          tenantHost: tenantReq.tenant.hostname,
        })
      );
    } catch (error) {
      next(error);
    }
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
