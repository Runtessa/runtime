import { RequestHandler, type Express } from 'express';
import { CryptoService } from '../../core/security/CryptoService';
import { TenantSessionStore } from '../../core/security/TenantSessionStore';

export type AuthSsoCookieOptions = {
  httpOnly: boolean;
  sameSite: 'lax' | 'none' | 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
};

export interface AuthSsoRuntimeOptions {
  cryptoService: CryptoService;
  tenantSessionStore: TenantSessionStore;
  ssoEnabled: boolean;
  authBaseUrl: string;
  scope: string;
  sessionCookieName: string;
  stateCookieName: string;
  sessionCookieOptions: AuthSsoCookieOptions;
  stateCookieOptions: AuthSsoCookieOptions;
}

export interface RegisterAuthSsoRoutesOptions extends AuthSsoRuntimeOptions {
  app: Express;
  contextMiddleware: RequestHandler;
  optionalAuthGuard: RequestHandler;
}
