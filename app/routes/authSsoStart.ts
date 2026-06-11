import { RequestHandler } from 'express';
import { resolveTenantOrgIdForSso, resolveTenantSsoConfig } from '../../core/security/ssoHelpers';
import { TenantRequest } from '../../types/RequestContext';
import {
  buildTenantSsoStart,
  issueSsoStateCookie,
  readReturnTo,
  redirectIfTenantSessionActive,
} from './authSsoRouteUtils';
import { AuthSsoRuntimeOptions } from './authSsoRouteTypes';

export const createTenantSsoStartHandler = (
  options: Pick<
    AuthSsoRuntimeOptions,
    | 'cryptoService'
    | 'tenantSessionStore'
    | 'sessionCookieName'
    | 'ssoEnabled'
    | 'authBaseUrl'
    | 'scope'
    | 'stateCookieName'
    | 'stateCookieOptions'
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

      const returnTo = readReturnTo(req);
      if (await redirectIfTenantSessionActive(req, res, tenantReq, options, returnTo)) {
        return;
      }

      const tenantSso = await resolveTenantSsoConfig(tenantReq, options.cryptoService, {
        authBaseUrl: options.authBaseUrl,
        scope: options.scope,
      });
      const tenantOrgRandId = await resolveTenantOrgIdForSso(
        req,
        tenantReq,
        options.cryptoService,
        returnTo,
      );
      const start = await buildTenantSsoStart(req, tenantReq, options, tenantSso, tenantOrgRandId, returnTo);
      issueSsoStateCookie(res, options, start.stateToken);
      return res.redirect(start.authorizeUrl);
    } catch (error) {
      next(error);
    }
  };
};
