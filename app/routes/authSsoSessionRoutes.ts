import type { Express, RequestHandler } from 'express';
import { readCookie } from '../../common/httpCookies';
import { TenantSessionStore } from '../../core/security/TenantSessionStore';
import {
  fetchTenantOrgAdapterPayload,
  normalizeSecretValue,
  parseTenantSsoOrgConfig,
  safeReturnTo,
} from '../../core/security/ssoHelpers';
import { CryptoService } from '../../core/security/CryptoService';
import { TenantRequest } from '../../types/RequestContext';

interface RegisterAuthSsoSessionRoutesOptions {
  app: Express;
  contextMiddleware: RequestHandler;
  optionalAuthGuard: RequestHandler;
  tenantSessionStore: TenantSessionStore;
  cryptoService: CryptoService;
  sessionCookieName: string;
  sessionCookieOptions: {
    httpOnly: boolean;
    sameSite: 'lax' | 'none' | 'strict';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

export const registerAuthSsoSessionRoutes = ({
  app,
  contextMiddleware,
  optionalAuthGuard,
  tenantSessionStore,
  cryptoService,
  sessionCookieName,
  sessionCookieOptions,
}: RegisterAuthSsoSessionRoutesOptions) => {
  app.post('/auth/logout', contextMiddleware, async (req, res, next) => {
    try {
      const sessionId = readCookie(req.headers.cookie, sessionCookieName);
      if (sessionId) {
        await tenantSessionStore.destroy(sessionId);
      }
      res.clearCookie(sessionCookieName, sessionCookieOptions);
      return res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/session', contextMiddleware, optionalAuthGuard, async (req, res) => {
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

  app.post('/api/auth/session/renew', contextMiddleware, optionalAuthGuard, async (req, res) => {
    const tenantReq = req as TenantRequest;
    if (!tenantReq.tenant || !tenantReq.account || !tenantReq.tenantSessionId) {
      return res.status(401).json({ ok: false });
    }
    await tenantSessionStore.touch(tenantReq.tenantSessionId);
    return res.status(200).json({ ok: true });
  });

  app.get('/api/auth/orgs', contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).json({ error: 'Tenant required' });
      }

      const returnTo = safeReturnTo(req.query.returnTo ?? req.query.return_to, '/');
      const orgConfig = parseTenantSsoOrgConfig(tenantReq);
      const adapterPayload = await fetchTenantOrgAdapterPayload(tenantReq, cryptoService, returnTo);
      const requestedOrgRandId = normalizeSecretValue(
        String(req.query.tenant_org_id || req.query[orgConfig.orgIdQueryParam] || req.query.org_id || '')
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
};
