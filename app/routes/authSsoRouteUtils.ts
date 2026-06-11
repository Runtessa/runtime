import { createHash, randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { readCookie } from '../../common/httpCookies';
import {
  AuthUserInfo,
  createPkcePair,
  normalizeOrganizations,
  normalizeRoleValues,
  normalizeSecretValue,
  normalizeStringArray,
  requestOrigin,
  safeReturnTo,
} from '../../core/security/ssoHelpers';
import { CoreAuthUser } from '../../types/AuthUser';
import { TenantRequest } from '../../types/RequestContext';
import { AuthSsoRuntimeOptions } from './authSsoRouteTypes';

export const readReturnTo = (req: Request) =>
  safeReturnTo(req.query.returnTo ?? req.query.return_to, '/');

export const redirectIfTenantSessionActive = async (
  req: Request,
  res: Response,
  tenantReq: TenantRequest,
  options: Pick<AuthSsoRuntimeOptions, 'tenantSessionStore' | 'sessionCookieName'>,
  returnTo: string,
) => {
  const existingSessionId = readCookie(req.headers.cookie, options.sessionCookieName);
  if (!existingSessionId) return false;

  const existingSession = await options.tenantSessionStore.touch(existingSessionId);
  if (!existingSession || existingSession.tenantId !== tenantReq.tenant?.id) return false;

  res.redirect(returnTo);
  return true;
};

export const buildTenantSsoStart = async (
  req: Request,
  tenantReq: TenantRequest,
  options: Pick<AuthSsoRuntimeOptions, 'cryptoService' | 'stateCookieName' | 'stateCookieOptions'>,
  tenantSso: {
    authBaseUrl: string;
    clientId: string;
    scope: string;
  },
  tenantOrgRandId: string | null,
  returnTo: string,
) => {
  const { codeVerifier, codeChallenge } = createPkcePair();
  const nonce = randomBytes(16).toString('hex');
  const stateToken = options.cryptoService.signToken(
    {
      sub: 'tenant-sso',
      tenantId: tenantReq.tenant!.id,
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
  authorizeUrl.searchParams.set('tenant_name', tenantReq.tenant!.hostname);
  authorizeUrl.searchParams.set('tenant_id', tenantReq.tenant!.id);
  authorizeUrl.searchParams.set(
    'allow_registration',
    String(tenantReq.tenant!.allowRegistration ?? true),
  );
  if (tenantOrgRandId) {
    authorizeUrl.searchParams.set('tenant_org_id', tenantOrgRandId);
  }

  return {
    stateToken,
    redirectUri,
    authorizeUrl: authorizeUrl.toString(),
  };
};

export const issueSsoStateCookie = (
  res: Response,
  options: Pick<AuthSsoRuntimeOptions, 'stateCookieName' | 'stateCookieOptions'>,
  stateToken: string,
) => {
  res.cookie(options.stateCookieName, stateToken, options.stateCookieOptions);
};

export const clearSsoStateCookie = (
  res: Response,
  options: Pick<AuthSsoRuntimeOptions, 'stateCookieName' | 'stateCookieOptions'>,
) => {
  res.clearCookie(options.stateCookieName, options.stateCookieOptions);
};

export const mapAuthUserInfoToCoreUser = (
  userInfo: AuthUserInfo,
  tenantHost: string,
): CoreAuthUser => {
  const normalizedEmail = String(userInfo.email || '').trim().toLowerCase();
  const effectiveEmail =
    normalizedEmail ||
    `${String(userInfo.sub || randomBytes(8).toString('hex')).replace(/[^a-zA-Z0-9._-]/g, '')}@${tenantHost}`;
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
  const tenantOrgRandId = normalizeSecretValue(
    String(userInfo.tenant_org_rand_id || userInfo.tenantOrgRandId || ''),
  ) || null;
  const effectiveAuthUserId = String(userInfo.sub || '').trim() || null;
  const effectiveUserId =
    effectiveAuthUserId || createHash('sha256').update(effectiveEmail).digest('hex').slice(0, 24);

  return {
    id: effectiveUserId,
    email: effectiveEmail,
    role: authRoles[0] || 'USER',
    roles: authRoles,
    groups: Array.from(
      new Set([
        ...normalizeStringArray(userInfo.groups),
        ...authRoles,
        ...organizations.map((org) => org.randId),
        ...organizations.map((org) => org.code || '').filter(Boolean),
        ...(tenantOrgRandId ? [tenantOrgRandId] : []),
      ]),
    ),
    organizations,
    tenantOrgRandId,
    authRandId: effectiveAuthUserId,
    firstName: userInfo.given_name || null,
    lastName: userInfo.family_name || null,
  };
};
