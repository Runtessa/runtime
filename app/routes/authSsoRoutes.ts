import { registerAuthSsoSessionRoutes } from './authSsoSessionRoutes';
import { createTenantLoginPageHandler } from './authSsoLoginPage';
import { createTenantSsoStartHandler } from './authSsoStart';
import { createTenantSsoCallbackHandler } from './authSsoCallback';
import { TenantRequest } from '../../types/RequestContext';
import { RegisterAuthSsoRoutesOptions } from './authSsoRouteTypes';

export const registerAuthSsoRoutes = ({
  app,
  contextMiddleware,
  optionalAuthGuard,
  ...runtime
}: RegisterAuthSsoRoutesOptions) => {
  app.get('/auth/config', contextMiddleware, async (req, res) => {
    const tenantReq = req as TenantRequest;
    res.status(200).json({
      allowRegistration: tenantReq.tenant?.allowRegistration ?? true,
      ssoEnabled: runtime.ssoEnabled,
      loginPath: '/login',
    });
  });

  app.get('/login', contextMiddleware, createTenantLoginPageHandler(runtime));
  app.get('/auth/start', contextMiddleware, createTenantSsoStartHandler(runtime));
  app.get('/auth', contextMiddleware, createTenantSsoCallbackHandler(runtime));

  registerAuthSsoSessionRoutes({
    app,
    contextMiddleware,
    optionalAuthGuard,
    tenantSessionStore: runtime.tenantSessionStore,
    cryptoService: runtime.cryptoService,
    sessionCookieName: runtime.sessionCookieName,
    sessionCookieOptions: runtime.sessionCookieOptions,
  });
};
