import { RequestHandler } from 'express';
import { AppError } from '../../common/AppError';
import { readCookie } from '../../common/httpCookies';
import {
  normalizeSecretValue,
  requestOrigin,
  resolveTenantSsoConfig,
  safeReturnTo,
} from '../../core/security/ssoHelpers';
import { TenantRequest } from '../../types/RequestContext';
import {
  clearSsoStateCookie,
  mapAuthUserInfoToCoreUser,
} from './authSsoRouteUtils';
import { AuthSsoRuntimeOptions } from './authSsoRouteTypes';

export const createTenantSsoCallbackHandler = (
  options: Pick<
    AuthSsoRuntimeOptions,
    | 'cryptoService'
    | 'tenantSessionStore'
    | 'sessionCookieName'
    | 'sessionCookieOptions'
    | 'stateCookieName'
    | 'stateCookieOptions'
    | 'ssoEnabled'
    | 'authBaseUrl'
    | 'scope'
  >,
): RequestHandler => {
  return async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send('Tenant required');
      }
      if (!options.ssoEnabled) {
        return res.status(503).send('SSO is not configured on core service');
      }

      const tenantSso = await resolveTenantSsoConfig(tenantReq, options.cryptoService, {
        authBaseUrl: options.authBaseUrl,
        scope: options.scope,
      });
      const authorizationCode = String(req.query.code || '').trim();
      const returnedState = String(req.query.state || '').trim();
      if (!authorizationCode || !returnedState) {
        throw new AppError('Missing authorization code/state', 400);
      }

      const stateToken = readCookie(req.headers.cookie, options.stateCookieName);
      clearSsoStateCookie(res, options);
      if (!stateToken) {
        throw new AppError('Missing SSO state cookie', 400);
      }

      const parsedState = options.cryptoService.verifyToken(stateToken);
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

      const redirectUri = `${requestOrigin(req)}/auth`;
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenForm.toString(),
      });
      const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!tokenResponse.ok) {
        throw new AppError(`SSO token exchange failed: ${String(tokenPayload.error || 'token_exchange_failed')}`, 401);
      }

      const accessToken = String(tokenPayload.access_token || tokenPayload.accessToken || '').trim();
      if (!accessToken) {
        throw new AppError('SSO token response missing access_token', 401);
      }

      const userInfoResponse = await fetch(new URL('/oauth/userinfo', tenantSso.authBaseUrl), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = (await userInfoResponse.json().catch(() => ({}))) as any;
      if (!userInfoResponse.ok) {
        throw new AppError(`SSO userinfo failed: ${String(userInfo.error || 'userinfo_failed')}`, 401);
      }
      if (userInfo.tenant_name && userInfo.tenant_name !== tenantReq.tenant.hostname) {
        throw new AppError('SSO tenant mismatch for returned user identity', 401);
      }
      if (userInfo.client_id && userInfo.client_id !== tenantSso.clientId) {
        throw new AppError('SSO client mismatch in userinfo response', 401);
      }
      const returnedTenantOrgRandId = normalizeSecretValue(
        String(userInfo.tenant_org_rand_id || userInfo.tenantOrgRandId || ''),
      );
      if (expectedTenantOrgRandId && returnedTenantOrgRandId && returnedTenantOrgRandId !== expectedTenantOrgRandId) {
        throw new AppError('SSO tenant organization mismatch in userinfo response', 401);
      }
      if (!userInfo.sub && !userInfo.email) {
        throw new AppError('SSO userinfo response missing user identity', 401);
      }

      const session = await options.tenantSessionStore.create({
        tenantId: tenantReq.tenant.id,
        tenantHost: tenantReq.tenant.hostname,
        user: mapAuthUserInfoToCoreUser(userInfo, tenantReq.tenant.hostname),
      });

      res.cookie(options.sessionCookieName, session.id, options.sessionCookieOptions);
      return res.redirect(returnTo);
    } catch (error) {
      next(error);
    }
  };
};
