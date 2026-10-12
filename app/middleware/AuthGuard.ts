import { NextFunction, Response } from "express";
import { DataSource } from "typeorm";
import { AppError } from "../../common/AppError";
import { CryptoService } from "../../core/security/CryptoService";
import { TenantRequest } from "../../types/RequestContext";
import { readCookie } from "../../common/httpCookies";
import { TenantSessionStore } from "../../core/security/TenantSessionStore";
import { CoreAuthUser } from "../../types/AuthUser";

export interface AuthGuardOptions {
  publicPaths?: RegExp[];
  sessionStore?: TenantSessionStore;
  sessionCookieName?: string;
  allowStudioPreview?: boolean;
}

const resolveAccountFromSession = async (
  req: TenantRequest,
  _dataSource: DataSource,
  sessionStore: TenantSessionStore,
  sessionCookieName: string,
) => {
  const sessionId = readCookie(req.headers.cookie, sessionCookieName);
  if (!sessionId) return null;

  const session = await sessionStore.touch(sessionId);
  if (!session) return null;
  if (!req.tenant || session.tenantId !== req.tenant.id) return null;

  req.account = session.user;
  req.tenantSessionId = session.id;
  req.authUser = {
    randId: session.user.authRandId,
    firstName: session.user.firstName,
    lastName: session.user.lastName,
  };
  req.tokenPayload = {
    sub: session.user.id,
    tenantId: session.tenantId,
    role: session.user.role,
    exp: Math.floor(Date.now() / 1000) + 60,
      metadata: {
        sessionId: session.id,
        authUserRandId: session.user.authRandId,
        email: session.user.email,
        roles: session.user.roles,
        groups: session.user.groups,
        organizations: session.user.organizations,
        tenantOrgRandId: session.user.tenantOrgRandId,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
      },
  };
  return session.user;
};

const userFromTokenPayload = (payload: ReturnType<CryptoService["verifyToken"]>): CoreAuthUser => {
  const metadata = (payload?.metadata || {}) as Record<string, unknown>;
  const roles = Array.isArray(metadata.roles)
    ? metadata.roles.map((item) => String(item)).filter(Boolean)
    : [];
  const groups = Array.isArray(metadata.groups)
    ? metadata.groups.map((item) => String(item)).filter(Boolean)
    : [];
  const organizations = Array.isArray(metadata.organizations)
    ? metadata.organizations
        .map((item) => {
          const org = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
          if (!org) return null;
          const randId = String(org.randId || "").trim();
          if (!randId) return null;
          const code = typeof org.code === "string" && org.code.trim() ? org.code.trim() : null;
          const name = typeof org.name === "string" && org.name.trim() ? org.name.trim() : null;
          return { randId, code, name };
        })
        .filter((item): item is { randId: string; code: string | null; name: string | null } => Boolean(item))
    : [];
  const email = typeof metadata.email === "string" && metadata.email.trim()
    ? metadata.email.trim().toLowerCase()
    : `${payload?.sub || "user"}@unknown.local`;

  return {
    id: String(payload?.sub || ""),
    email,
    role: String(payload?.role || "DEVELOPER"),
    roles,
    groups,
    organizations,
    tenantOrgRandId:
      typeof metadata.tenantOrgRandId === "string" && metadata.tenantOrgRandId.trim()
        ? metadata.tenantOrgRandId.trim()
        : null,
    authRandId:
      typeof metadata.authUserRandId === "string" && metadata.authUserRandId.trim()
        ? metadata.authUserRandId
        : null,
    firstName:
      typeof metadata.firstName === "string" && metadata.firstName.trim()
        ? metadata.firstName
        : null,
    lastName:
      typeof metadata.lastName === "string" && metadata.lastName.trim()
        ? metadata.lastName
        : null,
  };
};

export const AuthGuard =
  (dataSource: DataSource, cryptoService: CryptoService, options: AuthGuardOptions = {}) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError("Tenant context missing", 400);
      }

      const header = req.headers["authorization"];
      const hasBearer =
        typeof header === "string" &&
        (header.toLowerCase().startsWith("bearer ") ||
          header.toLowerCase().startsWith("session "));

      let payload = null as ReturnType<typeof cryptoService.verifyToken> | null;
      if (!hasBearer) {
        if (options.sessionStore && options.sessionCookieName) {
          const account = await resolveAccountFromSession(
            req,
            dataSource,
            options.sessionStore,
            options.sessionCookieName,
          );
          if (account) {
            return next();
          }
        }
        return res.status(401).json({ error: "Authentication required" });
      }

      const token = header.substring(header.indexOf(" ") + 1);
      payload = cryptoService.verifyToken(token);
      if (!payload || payload.tenantId !== req.tenant.id) {
        return res.status(401).json({ error: "Invalid token" });
      }

      if (payload.metadata?.purpose === 'studio-preview' && !options.allowStudioPreview) {
        return res.status(403).json({ error: 'Preview credentials cannot manage runtime resources' });
      }

      req.tokenPayload = payload;
      req.account = userFromTokenPayload(payload);

      next();
    } catch (error) {
      next(error);
    }
  };

export const OptionalAuthGuard =
  (dataSource: DataSource, cryptoService: CryptoService, options: AuthGuardOptions = {}) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError("Tenant context missing", 400);
      }
      const header = req.headers["authorization"];
      const hasBearer =
        typeof header === "string" &&
        (header.toLowerCase().startsWith("bearer ") ||
          header.toLowerCase().startsWith("session "));

      if (!hasBearer) {
        if (options.sessionStore && options.sessionCookieName) {
          await resolveAccountFromSession(
            req,
            dataSource,
            options.sessionStore,
            options.sessionCookieName,
          );
        }
        return next();
      }

      const token = header.substring(header.indexOf(" ") + 1);
      const payload = cryptoService.verifyToken(token);
      if (!payload || payload.tenantId !== req.tenant.id) {
        return res.status(401).json({ error: "Invalid token" });
      }

      if (payload.metadata?.purpose === 'studio-preview' && !options.allowStudioPreview) {
        return res.status(403).json({ error: 'Preview credentials cannot manage runtime resources' });
      }

      req.tokenPayload = payload;
      req.account = userFromTokenPayload(payload);
      next();
    } catch (error) {
      next(error);
    }
  };
