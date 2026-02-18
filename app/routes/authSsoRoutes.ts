import { createHash, randomBytes } from 'crypto';
import { RequestHandler, type Express } from 'express';
import { AppError } from '../../common/AppError';
import { readCookie } from '../../common/httpCookies';
import { CryptoService } from '../../core/security/CryptoService';
import { TenantSessionStore } from '../../core/security/TenantSessionStore';
import { registerAuthSsoSessionRoutes } from './authSsoSessionRoutes';
import {
  AuthUserInfo,
  createPkcePair,
  normalizeOrganizations,
  normalizeRoleValues,
  normalizeSecretValue,
  normalizeStringArray,
  requestOrigin,
  resolveTenantOrgIdForSso,
  resolveTenantSsoConfig,
  safeReturnTo,
} from '../../core/security/ssoHelpers';
import { CoreAuthUser } from '../../types/AuthUser';
import { TenantRequest } from '../../types/RequestContext';

interface RegisterAuthSsoRoutesOptions {
  app: Express;
  contextMiddleware: RequestHandler;
  optionalAuthGuard: RequestHandler;
  cryptoService: CryptoService;
  tenantSessionStore: TenantSessionStore;
  ssoEnabled: boolean;
  authBaseUrl: string;
  scope: string;
  sessionCookieName: string;
  stateCookieName: string;
  sessionCookieOptions: {
    httpOnly: boolean;
    sameSite: 'lax' | 'none' | 'strict';
    secure: boolean;
    path: string;
    maxAge: number;
  };
  stateCookieOptions: {
    httpOnly: boolean;
    sameSite: 'lax' | 'none' | 'strict';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

export const registerAuthSsoRoutes = ({
  app,
  contextMiddleware,
  optionalAuthGuard,
  cryptoService,
  tenantSessionStore,
  ssoEnabled,
  authBaseUrl,
  scope,
  sessionCookieName,
  stateCookieName,
  sessionCookieOptions,
  stateCookieOptions,
}: RegisterAuthSsoRoutesOptions) => {
  app.get('/auth/config', contextMiddleware, async (req, res) => {
    const tenantReq = req as TenantRequest;
    res.status(200).json({
      allowRegistration: tenantReq.tenant?.allowRegistration ?? true,
      ssoEnabled,
      loginPath: '/login',
    });
  });

  app.get('/login', contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send('Tenant required');
      }
      if (!ssoEnabled) {
        return res.status(503).send('SSO is not configured on core service');
      }
      const tenantSso = await resolveTenantSsoConfig(tenantReq, cryptoService, {
        authBaseUrl,
        scope,
      });

      const returnTo = safeReturnTo(req.query.returnTo ?? req.query.return_to, '/');
      const existingSessionId = readCookie(req.headers.cookie, sessionCookieName);
      if (existingSessionId) {
        const existingSession = await tenantSessionStore.touch(existingSessionId);
        if (existingSession && existingSession.tenantId === tenantReq.tenant.id) {
          return res.redirect(returnTo);
        }
      }

      const { codeVerifier, codeChallenge } = createPkcePair();
      const nonce = randomBytes(16).toString('hex');
      const tenantOrgRandId = await resolveTenantOrgIdForSso(
        req,
        tenantReq,
        cryptoService,
        returnTo,
      );
      const stateToken = cryptoService.signToken(
        {
          sub: 'tenant-sso',
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
      const authorizeUrl = new URL('/oauth/authorize', tenantSso.authBaseUrl);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', tenantSso.clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('scope', tenantSso.scope);
      authorizeUrl.searchParams.set('state', nonce);
      authorizeUrl.searchParams.set('code_challenge', codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('tenant_name', tenantReq.tenant.hostname);
      authorizeUrl.searchParams.set('tenant_id', tenantReq.tenant.id);
      authorizeUrl.searchParams.set(
        'allow_registration',
        String(tenantReq.tenant.allowRegistration ?? true),
      );
      if (tenantOrgRandId) {
        authorizeUrl.searchParams.set('tenant_org_id', tenantOrgRandId);
      }

      res.cookie(stateCookieName, stateToken, stateCookieOptions);
      return res.redirect(authorizeUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth', contextMiddleware, async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send('Tenant required');
      }
      if (!ssoEnabled) {
        return res.status(503).send('SSO is not configured on core service');
      }
      const tenantSso = await resolveTenantSsoConfig(tenantReq, cryptoService, {
        authBaseUrl,
        scope,
      });

      const authorizationCode = String(req.query.code || '').trim();
      const returnedState = String(req.query.state || '').trim();
      if (!authorizationCode || !returnedState) {
        throw new AppError('Missing authorization code/state', 400);
      }

      const stateToken = readCookie(req.headers.cookie, stateCookieName);
      res.clearCookie(stateCookieName, stateCookieOptions);
      if (!stateToken) {
        throw new AppError('Missing SSO state cookie', 400);
      }

      const parsedState = cryptoService.verifyToken(stateToken);
      if (!parsedState || parsedState.tenantId !== tenantReq.tenant.id) {
        throw new AppError('Invalid SSO state', 400);
      }

      const stateMeta = (parsedState.metadata || {}) as Record<string, unknown>;
      const expectedNonce = String(stateMeta.nonce || '').trim();
      const returnTo = safeReturnTo(stateMeta.returnTo, '/');
      const codeVerifier = String(stateMeta.codeVerifier || '').trim();
      const expectedClientId = String(stateMeta.clientId || '').trim();
      const expectedTenantOrgRandId = normalizeSecretValue(
        String(stateMeta.tenantOrgRandId || stateMeta.tenant_org_rand_id || ''),
      );

      if (!expectedNonce || expectedNonce !== returnedState) {
        throw new AppError('SSO state mismatch', 400);
      }
      if (!codeVerifier) {
        throw new AppError('Missing PKCE verifier for SSO callback', 400);
      }
      if (expectedClientId && expectedClientId !== tenantSso.clientId) {
        throw new AppError('SSO client changed between login and callback', 400);
      }

      const origin = requestOrigin(req);
      const redirectUri = `${origin}/auth`;

      const tokenForm = new URLSearchParams();
      tokenForm.set('grant_type', 'authorization_code');
      tokenForm.set('client_id', tenantSso.clientId);
      tokenForm.set('client_secret', tenantSso.clientSecret);
      tokenForm.set('code', authorizationCode);
      tokenForm.set('redirect_uri', redirectUri);
      tokenForm.set('code_verifier', codeVerifier);
      tokenForm.set('tenant_name', tenantReq.tenant.hostname);
      tokenForm.set('tenant_sso_token', tenantSso.tenantSsoToken);
      if (expectedTenantOrgRandId) {
        tokenForm.set('tenant_org_id', expectedTenantOrgRandId);
      }

      const tokenResponse = await fetch(new URL('/oauth/token', tenantSso.authBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenForm.toString(),
      });
      const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!tokenResponse.ok) {
        const reason = String(tokenPayload.error || 'token_exchange_failed');
        throw new AppError(`SSO token exchange failed: ${reason}`, 401);
      }
      const accessToken = String(tokenPayload.access_token || tokenPayload.accessToken || '').trim();
      if (!accessToken) {
        const availableKeys = Object.keys(tokenPayload).join(', ');
        throw new AppError(
          `SSO token response missing access_token (available keys: ${availableKeys || 'none'})`,
          401,
        );
      }

      const userInfoResponse = await fetch(new URL('/oauth/userinfo', tenantSso.authBaseUrl), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const userInfo = (await userInfoResponse.json().catch(() => ({}))) as AuthUserInfo;
      if (!userInfoResponse.ok) {
        const reason = String((userInfo as unknown as Record<string, unknown>).error || 'userinfo_failed');
        throw new AppError(`SSO userinfo failed: ${reason}`, 401);
      }
      if (userInfo.tenant_name && userInfo.tenant_name !== tenantReq.tenant.hostname) {
        throw new AppError('SSO tenant mismatch for returned user identity', 401);
      }
      if (userInfo.client_id && userInfo.client_id !== tenantSso.clientId) {
        throw new AppError('SSO client mismatch in userinfo response', 401);
      }
      const userInfoTenantOrgRandId = normalizeSecretValue(
        String(userInfo.tenant_org_rand_id || userInfo.tenantOrgRandId || ''),
      );
      if (
        expectedTenantOrgRandId &&
        userInfoTenantOrgRandId &&
        userInfoTenantOrgRandId !== expectedTenantOrgRandId
      ) {
        throw new AppError('SSO tenant organization mismatch in userinfo response', 401);
      }
      if (!userInfo.sub && !userInfo.email) {
        throw new AppError('SSO userinfo response missing user identity', 401);
      }

      const normalizedEmail = String(userInfo.email || '')
        .trim()
        .toLowerCase();
      const effectiveEmail =
        normalizedEmail ||
        `${String(userInfo.sub || randomBytes(8).toString('hex')).replace(/[^a-zA-Z0-9._-]/g, '')}@${tenantReq.tenant.hostname}`;
      const authRoles = Array.from(
        new Set(
          [
            userInfo.role,
            userInfo.role_code,
            ...normalizeStringArray(userInfo.roles),
            ...normalizeRoleValues(userInfo.roles),
          ]
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      );
      const organizations = normalizeOrganizations(userInfo.organizations);
      const effectiveRole = authRoles[0] || 'USER';
      const effectiveTenantOrgRandId = userInfoTenantOrgRandId || null;
      const effectiveGroups = Array.from(
        new Set([
          ...normalizeStringArray(userInfo.groups),
          ...authRoles,
          ...organizations.map((org) => org.randId),
          ...organizations.map((org) => org.code || '').filter(Boolean),
          ...(effectiveTenantOrgRandId ? [effectiveTenantOrgRandId] : []),
        ]),
      );
      const effectiveAuthUserId = String(userInfo.sub || '').trim() || null;
      const effectiveUserId =
        effectiveAuthUserId || createHash('sha256').update(effectiveEmail).digest('hex').slice(0, 24);

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

      res.cookie(sessionCookieName, session.id, sessionCookieOptions);
      return res.redirect(returnTo);
    } catch (error) {
      next(error);
    }
  });

  registerAuthSsoSessionRoutes({
    app,
    contextMiddleware,
    optionalAuthGuard,
    tenantSessionStore,
    cryptoService,
    sessionCookieName,
    sessionCookieOptions,
  });
};
