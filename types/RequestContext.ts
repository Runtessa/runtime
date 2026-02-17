import { Request } from 'express';
import { Tenant } from '@idp/shared';
import { TokenPayload } from '../core/security/CryptoService';
import { CoreAuthUser } from './AuthUser';

export interface TenantRequest extends Request {
  tenant?: Tenant;
  account?: CoreAuthUser;
  tokenPayload?: TokenPayload;
  tenantSessionId?: string;
  authUser?: {
    randId: string | null;
    firstName: string | null;
    lastName: string | null;
  };
}
