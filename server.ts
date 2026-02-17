import "dotenv/config";
import "reflect-metadata";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
import { createHash, randomBytes } from "crypto";
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
import { Secret } from "@idp/shared";
import { TenantRequest } from "./types/RequestContext";
import { MonitoringService } from "./core/monitoring/MonitoringService";
import { TenantSessionStore } from "./core/security/TenantSessionStore";
import { readCookie } from "./common/httpCookies";
import { CoreAuthUser } from "./types/AuthUser";

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

interface AuthUserInfo {
  sub: string | null;
  email: string | null;
  given_name: string | null;
  family_name: string | null;
  role?: string | null;
  role_code?: string | null;
  roles?: string[] | null;
  groups?: string[] | null;
  organizations?: Array<{
    org_rand_id?: string | null;
    org_code?: string | null;
    org_name?: string | null;
    orgRandId?: string | null;
    orgCode?: string | null;
    orgName?: string | null;
  }> | null;
  tenant_org_rand_id?: string | null;
  tenantOrgRandId?: string | null;
  tenant_rand_id: string | null;
  tenant_name: string | null;
  tenant_code: string | null;
  client_id: string | null;
  scope: string | null;
}

interface TenantSsoConfig {
  authBaseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  tenantSsoToken: string;
}

interface TenantSsoOrgConfig {
  staticOrgRandId: string | null;
  orgIdQueryParam: string;
  orgIdHeader: string;
  adapterUrl: string | null;
  adapterTimeoutMs: number;
  adapterTokenSecretKey: string | null;
  adapterRequired: boolean;
}

interface TenantOrgOption {
  orgRandId: string;
  code: string | null;
  name: string | null;
}

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const normalizeSecretValue = (value: string | null | undefined): string | null => {
  const text = String(value || "").trim();
  return text || null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeRoleValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((item) => {
      if (typeof item === "string") return item;
      const obj = asObject(item);
      return String(
        obj.role_code || obj.roleCode || obj.code || obj.role || obj.name || "",
      );
    })
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(out));
};

const normalizeOrganizations = (
  value: unknown,
): Array<{ randId: string; code: string | null; name: string | null }> => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ randId: string; code: string | null; name: string | null }> = [];
  for (const item of value) {
    const obj = asObject(item);
    const randId = String(obj.org_rand_id || obj.orgRandId || "").trim();
    if (!randId) continue;
    const code = normalizeSecretValue(String(obj.org_code || obj.orgCode || ""));
    const name = normalizeSecretValue(String(obj.org_name || obj.orgName || ""));
    out.push({ randId, code, name });
  }
  return out;
};

const safeReturnTo = (input: unknown, fallback = "/"): string => {
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
};

const requestOrigin = (req: Request): string => {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    ?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    ?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "localhost";
  return `${protocol}://${host}`;
};

const createPkcePair = () => {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
};

const readTenantSecretValue = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  keyName: string,
): Promise<string | null> => {
  if (!tenantReq.tenant || !keyName.trim()) return null;
  const secretRepo = AppDataSource.getRepository(Secret);
  const secret = await secretRepo.findOne({
    where: {
      tenant: { id: tenantReq.tenant.id },
      keyName: keyName.trim(),
    },
  });
  if (!secret) return null;
  try {
    return cryptoService.decryptSecret({
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      authTag: secret.authTag,
    });
  } catch {
    throw new AppError(`Tenant secret ${keyName} failed to decrypt`, 500);
  }
};

const readTenantSsoBlock = (tenantReq: TenantRequest): Record<string, unknown> => {
  const adapterConfig = asObject(tenantReq.tenant?.adapterConfig);
  const authBlock = asObject(adapterConfig.auth);
  return {
    ...asObject(adapterConfig.sso),
    ...asObject(authBlock.sso),
  };
};

const parseTenantSsoOrgConfig = (
  tenantReq: TenantRequest,
): TenantSsoOrgConfig => {
  const ssoBlock = readTenantSsoBlock(tenantReq);
  const orgIdQueryParamRaw = normalizeSecretValue(
    String(
      ssoBlock.orgIdQueryParam ||
        ssoBlock.org_id_query_param ||
        "tenant_org_id",
    ),
  );
  const orgIdHeaderRaw = normalizeSecretValue(
    String(
      ssoBlock.orgIdHeader ||
        ssoBlock.org_id_header ||
        "x-tenant-org-id",
    ),
  );
  const normalizedOrgIdQueryParam = String(orgIdQueryParamRaw || "tenant_org_id")
    .replace(/[^a-zA-Z0-9._-]/g, "");
  const normalizedOrgIdHeader = String(orgIdHeaderRaw || "x-tenant-org-id")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return {
    staticOrgRandId: normalizeSecretValue(
      String(
        ssoBlock.orgId ||
          ssoBlock.org_id ||
          ssoBlock.tenantOrgRandId ||
          ssoBlock.tenant_org_rand_id ||
          "",
      ),
    ),
    orgIdQueryParam: normalizedOrgIdQueryParam || "tenant_org_id",
    orgIdHeader: normalizedOrgIdHeader || "x-tenant-org-id",
    adapterUrl: normalizeSecretValue(
      String(
        ssoBlock.orgAdapterUrl ||
          ssoBlock.org_adapter_url ||
          "",
      ),
    ),
    adapterTimeoutMs: Math.max(
      300,
      parseInt(String(ssoBlock.orgAdapterTimeoutMs || ssoBlock.org_adapter_timeout_ms || "3000"), 10) || 3000,
    ),
    adapterTokenSecretKey: normalizeSecretValue(
      String(
        ssoBlock.orgAdapterTokenSecretKey ||
          ssoBlock.org_adapter_token_secret_key ||
          "",
      ),
    ),
    adapterRequired:
      String(ssoBlock.orgAdapterRequired || ssoBlock.org_adapter_required || "false")
        .trim()
        .toLowerCase() === "true",
  };
};

const parseOrgOptionsFromAdapterPayload = (value: unknown): TenantOrgOption[] => {
  if (!Array.isArray(value)) return [];
  const out: TenantOrgOption[] = [];
  for (const item of value) {
    const obj = asObject(item);
    const orgRandId = normalizeSecretValue(
      String(
        obj.orgRandId ||
          obj.org_rand_id ||
          obj.id ||
          "",
      ),
    );
    if (!orgRandId) continue;
    out.push({
      orgRandId,
      code: normalizeSecretValue(String(obj.code || obj.orgCode || obj.org_code || "")),
      name: normalizeSecretValue(String(obj.name || obj.orgName || obj.org_name || "")),
    });
  }
  return out;
};

const fetchTenantOrgAdapterPayload = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  returnTo: string,
): Promise<{ defaultOrgRandId: string | null; organizations: TenantOrgOption[] }> => {
  const orgConfig = parseTenantSsoOrgConfig(tenantReq);
  if (!orgConfig.adapterUrl) {
    return {
      defaultOrgRandId: orgConfig.staticOrgRandId,
      organizations: [],
    };
  }

  try {
    const url = new URL(orgConfig.adapterUrl);
    url.searchParams.set("tenant_name", tenantReq.tenant?.hostname || "");
    url.searchParams.set("tenant_id", tenantReq.tenant?.id || "");
    url.searchParams.set("return_to", returnTo || "/");

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (orgConfig.adapterTokenSecretKey) {
      const token = await readTenantSecretValue(
        tenantReq,
        cryptoService,
        orgConfig.adapterTokenSecretKey,
      );
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), orgConfig.adapterTimeoutMs);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (orgConfig.adapterRequired) {
          throw new AppError(`Tenant org adapter failed (${response.status})`, 503);
        }
        return {
          defaultOrgRandId: orgConfig.staticOrgRandId,
          organizations: [],
        };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const organizations = parseOrgOptionsFromAdapterPayload(payload.organizations);
      const defaultOrgRandId =
        normalizeSecretValue(
          String(
            payload.defaultOrgRandId ||
              payload.default_org_rand_id ||
              payload.orgRandId ||
              payload.org_id ||
              "",
          ),
        ) ||
        orgConfig.staticOrgRandId ||
        organizations[0]?.orgRandId ||
        null;

      return {
        defaultOrgRandId,
        organizations,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    if (orgConfig.adapterRequired) {
      throw error;
    }
    return {
      defaultOrgRandId: orgConfig.staticOrgRandId,
      organizations: [],
    };
  }
};

const resolveTenantOrgIdForSso = async (
  req: Request,
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  returnTo: string,
): Promise<string | null> => {
  const orgConfig = parseTenantSsoOrgConfig(tenantReq);
  const queryOrgRandId = normalizeSecretValue(
    String(
      req.query.tenant_org_id ||
        req.query[orgConfig.orgIdQueryParam] ||
        req.query.org_id ||
        "",
    ),
  );
  if (queryOrgRandId) return queryOrgRandId;

  const headerOrgRandId = normalizeSecretValue(
    String(
      req.headers[orgConfig.orgIdHeader] ||
        req.headers["x-tenant-org-id"] ||
        "",
    ),
  );
  if (headerOrgRandId) return headerOrgRandId;

  const adapterPayload = await fetchTenantOrgAdapterPayload(
    tenantReq,
    cryptoService,
    returnTo,
  );
  return adapterPayload.defaultOrgRandId || orgConfig.staticOrgRandId || null;
};

const resolveTenantSsoConfig = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
): Promise<TenantSsoConfig> => {
  if (!tenantReq.tenant) {
    throw new AppError("Tenant required", 400);
  }

  const adapterConfig = asObject(tenantReq.tenant.adapterConfig);
  const authBlock = asObject(adapterConfig.auth);
  const ssoBlock = {
    ...asObject(adapterConfig.sso),
    ...asObject(authBlock.sso),
  };

  const authBaseUrl =
    normalizeSecretValue(String(ssoBlock.authBaseUrl || ssoBlock.auth_base_url || "")) ||
    CORE_SSO_AUTH_BASE_URL;
  if (!authBaseUrl) {
    throw new AppError("SSO auth base URL is missing. Set CORE_SSO_AUTH_BASE_URL or tenant sso.authBaseUrl", 500);
  }

  const clientIdSecretKey =
    normalizeSecretValue(String(
      ssoBlock.clientIdSecretKey ||
        ssoBlock.client_id_secret_key ||
        ssoBlock.oauthClientIdSecretKey ||
        "auth:sso:client_id",
    )) || "auth:sso:client_id";
  const clientSecretSecretKey =
    normalizeSecretValue(String(
      ssoBlock.clientSecretSecretKey ||
        ssoBlock.client_secret_secret_key ||
        ssoBlock.oauthClientSecretSecretKey ||
        "auth:sso:client_secret",
    )) || "auth:sso:client_secret";
  const tenantTokenSecretKey =
    normalizeSecretValue(String(
      ssoBlock.tenantTokenSecretKey ||
        ssoBlock.tenant_token_secret_key ||
        ssoBlock.tenantSsoTokenSecretKey ||
        "auth:sso:tenant_token",
    )) || "auth:sso:tenant_token";

  const clientIdFromSecret = await readTenantSecretValue(tenantReq, cryptoService, clientIdSecretKey);
  const clientSecretFromSecret = await readTenantSecretValue(tenantReq, cryptoService, clientSecretSecretKey);
  const tenantTokenFromSecret = await readTenantSecretValue(tenantReq, cryptoService, tenantTokenSecretKey);

  const clientId = normalizeSecretValue(clientIdFromSecret);
  const clientSecret = normalizeSecretValue(clientSecretFromSecret);
  const tenantSsoToken = normalizeSecretValue(tenantTokenFromSecret);
  const scope =
    normalizeSecretValue(String(ssoBlock.scope || "")) ||
    CORE_SSO_SCOPE;

  if (!clientId || !clientSecret) {
    throw new AppError(
      `Tenant SSO client credentials are missing for ${tenantReq.tenant.hostname}. Store them in tenant secrets (${clientIdSecretKey}, ${clientSecretSecretKey}).`,
      500,
    );
  }
  if (!tenantSsoToken) {
    throw new AppError(
      `Tenant SSO token is missing for ${tenantReq.tenant.hostname}. Store it in tenant secret ${tenantTokenSecretKey}.`,
      500,
    );
  }

  return {
    authBaseUrl,
    clientId,
    clientSecret,
    scope,
    tenantSsoToken,
  };
};

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

  app.get("/auth/config", contextMiddleware, async (req, res) => {
    const tenantReq = req as TenantRequest;
    res.status(200).json({
      allowRegistration: tenantReq.tenant?.allowRegistration ?? true,
      ssoEnabled,
      loginPath: "/login",
    });
  });

  app.get("/login", contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send("Tenant required");
      }
      if (!ssoEnabled) {
        return res.status(503).send("SSO is not configured on core service");
      }
      const tenantSso = await resolveTenantSsoConfig(tenantReq, cryptoService);

      const returnTo = safeReturnTo(req.query.returnTo ?? req.query.return_to, "/");
      const existingSessionId = readCookie(req.headers.cookie, CORE_SSO_COOKIE_NAME);
      if (existingSessionId) {
        const existingSession = await tenantSessionStore.touch(existingSessionId);
        if (existingSession && existingSession.tenantId === tenantReq.tenant.id) {
          return res.redirect(returnTo);
        }
      }

      const { codeVerifier, codeChallenge } = createPkcePair();
      const nonce = randomBytes(16).toString("hex");
      const tenantOrgRandId = await resolveTenantOrgIdForSso(
        req,
        tenantReq,
        cryptoService,
        returnTo,
      );
      const stateToken = cryptoService.signToken(
        {
          sub: "tenant-sso",
          tenantId: tenantReq.tenant.id,
          metadata: {
            nonce,
            returnTo,
            codeVerifier,
            clientId: tenantSso.clientId,
            tenantOrgRandId,
          },
        },
        10 * 60,
      );

      const origin = requestOrigin(req);
      const redirectUri = `${origin}/auth`;
      const authorizeUrl = new URL("/oauth/authorize", tenantSso.authBaseUrl);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", tenantSso.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", tenantSso.scope);
      authorizeUrl.searchParams.set("state", nonce);
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("tenant_name", tenantReq.tenant.hostname);
      authorizeUrl.searchParams.set("tenant_id", tenantReq.tenant.id);
      authorizeUrl.searchParams.set(
        "allow_registration",
        String(tenantReq.tenant.allowRegistration ?? true),
      );
      if (tenantOrgRandId) {
        authorizeUrl.searchParams.set("tenant_org_id", tenantOrgRandId);
      }

      res.cookie(CORE_SSO_STATE_COOKIE_NAME, stateToken, ssoStateCookieOptions);
      return res.redirect(authorizeUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth", contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send("Tenant required");
      }
      if (!ssoEnabled) {
        return res.status(503).send("SSO is not configured on core service");
      }
      const tenantSso = await resolveTenantSsoConfig(tenantReq, cryptoService);

      const authorizationCode = String(req.query.code || "").trim();
      const returnedState = String(req.query.state || "").trim();
      if (!authorizationCode || !returnedState) {
        throw new AppError("Missing authorization code/state", 400);
      }

      const stateToken = readCookie(req.headers.cookie, CORE_SSO_STATE_COOKIE_NAME);
      res.clearCookie(CORE_SSO_STATE_COOKIE_NAME, ssoStateCookieOptions);
      if (!stateToken) {
        throw new AppError("Missing SSO state cookie", 400);
      }

      const parsedState = cryptoService.verifyToken(stateToken);
      if (!parsedState || parsedState.tenantId !== tenantReq.tenant.id) {
        throw new AppError("Invalid SSO state", 400);
      }

      const stateMeta = (parsedState.metadata || {}) as Record<string, unknown>;
      const expectedNonce = String(stateMeta.nonce || "").trim();
      const returnTo = safeReturnTo(stateMeta.returnTo, "/");
      const codeVerifier = String(stateMeta.codeVerifier || "").trim();
      const expectedClientId = String(stateMeta.clientId || "").trim();
      const expectedTenantOrgRandId = normalizeSecretValue(
        String(stateMeta.tenantOrgRandId || stateMeta.tenant_org_rand_id || ""),
      );

      if (!expectedNonce || expectedNonce !== returnedState) {
        throw new AppError("SSO state mismatch", 400);
      }
      if (!codeVerifier) {
        throw new AppError("Missing PKCE verifier for SSO callback", 400);
      }
      if (expectedClientId && expectedClientId !== tenantSso.clientId) {
        throw new AppError("SSO client changed between login and callback", 400);
      }

      const origin = requestOrigin(req);
      const redirectUri = `${origin}/auth`;

      const tokenForm = new URLSearchParams();
      tokenForm.set("grant_type", "authorization_code");
      tokenForm.set("client_id", tenantSso.clientId);
      tokenForm.set("client_secret", tenantSso.clientSecret);
      tokenForm.set("code", authorizationCode);
      tokenForm.set("redirect_uri", redirectUri);
      tokenForm.set("code_verifier", codeVerifier);
      tokenForm.set("tenant_name", tenantReq.tenant.hostname);
      tokenForm.set("tenant_sso_token", tenantSso.tenantSsoToken);
      if (expectedTenantOrgRandId) {
        tokenForm.set("tenant_org_id", expectedTenantOrgRandId);
      }

      const tokenResponse = await fetch(new URL("/oauth/token", tenantSso.authBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenForm.toString(),
      });
      const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!tokenResponse.ok) {
        const reason = String(tokenPayload.error || "token_exchange_failed");
        throw new AppError(`SSO token exchange failed: ${reason}`, 401);
      }
      const accessToken = String(tokenPayload.access_token || tokenPayload.accessToken || "").trim();
      if (!accessToken) {
        const availableKeys = Object.keys(tokenPayload).join(", ");
        throw new AppError(
          `SSO token response missing access_token (available keys: ${availableKeys || "none"})`,
          401,
        );
      }

      const userInfoResponse = await fetch(new URL("/oauth/userinfo", tenantSso.authBaseUrl), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const userInfo = (await userInfoResponse.json().catch(() => ({}))) as AuthUserInfo;
      if (!userInfoResponse.ok) {
        const reason = String((userInfo as unknown as Record<string, unknown>).error || "userinfo_failed");
        throw new AppError(`SSO userinfo failed: ${reason}`, 401);
      }
      if (userInfo.tenant_name && userInfo.tenant_name !== tenantReq.tenant.hostname) {
        throw new AppError("SSO tenant mismatch for returned user identity", 401);
      }
      if (userInfo.client_id && userInfo.client_id !== tenantSso.clientId) {
        throw new AppError("SSO client mismatch in userinfo response", 401);
      }
      const userInfoTenantOrgRandId = normalizeSecretValue(
        String(userInfo.tenant_org_rand_id || userInfo.tenantOrgRandId || ""),
      );
      if (
        expectedTenantOrgRandId &&
        userInfoTenantOrgRandId &&
        userInfoTenantOrgRandId !== expectedTenantOrgRandId
      ) {
        throw new AppError("SSO tenant organization mismatch in userinfo response", 401);
      }
      if (!userInfo.sub && !userInfo.email) {
        throw new AppError("SSO userinfo response missing user identity", 401);
      }

      const normalizedEmail = String(userInfo.email || "")
        .trim()
        .toLowerCase();
      const effectiveEmail =
        normalizedEmail ||
        `${String(userInfo.sub || randomBytes(8).toString("hex")).replace(/[^a-zA-Z0-9._-]/g, "")}@${tenantReq.tenant.hostname}`;
      const authRoles = Array.from(
        new Set(
          [
            userInfo.role,
            userInfo.role_code,
            ...normalizeStringArray(userInfo.roles),
            ...normalizeRoleValues(userInfo.roles),
          ]
            .map((item) => String(item || "").trim())
            .filter(Boolean),
        ),
      );
      const organizations = normalizeOrganizations(userInfo.organizations);
      const effectiveRole = authRoles[0] || "USER";
      const effectiveTenantOrgRandId =
        userInfoTenantOrgRandId || null;
      const effectiveGroups = Array.from(
        new Set([
          ...normalizeStringArray(userInfo.groups),
          ...authRoles,
          ...organizations.map((org) => org.randId),
          ...organizations.map((org) => org.code || "").filter(Boolean),
          ...(effectiveTenantOrgRandId ? [effectiveTenantOrgRandId] : []),
        ]),
      );
      const effectiveAuthUserId = String(userInfo.sub || "").trim() || null;
      const effectiveUserId =
        effectiveAuthUserId || createHash("sha256").update(effectiveEmail).digest("hex").slice(0, 24);

      const user: CoreAuthUser = {
        id: effectiveUserId,
        email: effectiveEmail,
        role: effectiveRole,
        roles: authRoles,
        groups: effectiveGroups,
        organizations,
        tenantOrgRandId: effectiveTenantOrgRandId,
        authRandId: effectiveAuthUserId,
        firstName: userInfo.given_name || null,
        lastName: userInfo.family_name || null,
      };

      const session = await tenantSessionStore.create({
        tenantId: tenantReq.tenant.id,
        tenantHost: tenantReq.tenant.hostname,
        user,
      });

      res.cookie(CORE_SSO_COOKIE_NAME, session.id, sessionCookieOptions);
      return res.redirect(returnTo);
    } catch (error) {
      next(error);
    }
  });

  app.post("/auth/logout", contextMiddleware, async (req, res, next) => {
    try {
      const sessionId = readCookie(req.headers.cookie, CORE_SSO_COOKIE_NAME);
      if (sessionId) {
        await tenantSessionStore.destroy(sessionId);
      }
      res.clearCookie(CORE_SSO_COOKIE_NAME, sessionCookieOptions);
      return res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/session", contextMiddleware, optionalAuthGuard, async (req, res) => {
    const tenantReq = req as TenantRequest;
    if (!tenantReq.tenant || !tenantReq.account) {
      return res.status(401).json({ authenticated: false });
    }

    return res.status(200).json({
      authenticated: true,
      user: {
        id: tenantReq.account.id,
        email: tenantReq.account.email,
        role: tenantReq.account.role,
        roles: tenantReq.account.roles || [],
        groups: tenantReq.account.groups || [],
        organizations: tenantReq.account.organizations || [],
        tenantOrgRandId: tenantReq.account.tenantOrgRandId || null,
        authRandId: tenantReq.account.authRandId || null,
        firstName: tenantReq.account.firstName || null,
        lastName: tenantReq.account.lastName || null,
      },
      tenant: {
        id: tenantReq.tenant.id,
        hostname: tenantReq.tenant.hostname,
      },
    });
  });

  app.post("/api/auth/session/renew", contextMiddleware, optionalAuthGuard, async (req, res) => {
    const tenantReq = req as TenantRequest;
    if (!tenantReq.tenant || !tenantReq.account || !tenantReq.tenantSessionId) {
      return res.status(401).json({ ok: false });
    }
    await tenantSessionStore.touch(tenantReq.tenantSessionId);
    return res.status(200).json({ ok: true });
  });

  app.get("/api/auth/orgs", contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).json({ error: "Tenant required" });
      }

      const returnTo = safeReturnTo(req.query.returnTo ?? req.query.return_to, "/");
      const orgConfig = parseTenantSsoOrgConfig(tenantReq);
      const adapterPayload = await fetchTenantOrgAdapterPayload(
        tenantReq,
        cryptoService,
        returnTo,
      );
      const requestedOrgRandId = normalizeSecretValue(
        String(
          req.query.tenant_org_id ||
            req.query[orgConfig.orgIdQueryParam] ||
            req.query.org_id ||
            "",
        ),
      );
      const effectiveOrgRandId =
        requestedOrgRandId ||
        adapterPayload.defaultOrgRandId ||
        orgConfig.staticOrgRandId ||
        null;

      return res.status(200).json({
        tenant: {
          id: tenantReq.tenant.id,
          hostname: tenantReq.tenant.hostname,
        },
        orgIdQueryParam: orgConfig.orgIdQueryParam,
        orgIdHeader: orgConfig.orgIdHeader,
        defaultOrgRandId: adapterPayload.defaultOrgRandId || orgConfig.staticOrgRandId || null,
        selectedOrgRandId: effectiveOrgRandId,
        organizations: adapterPayload.organizations,
      });
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
