import { Request } from 'express';
import { Account } from '@idp/shared';
import { Tenant } from '@idp/shared';
import { TokenPayload } from '../core/security/CryptoService';

export interface TenantRequest extends Request {
  tenant?: Tenant;
  account?: Account;
  tokenPayload?: TokenPayload;
}
