import { Tenant } from '@idp/shared';
import { asObject, getObjectValue } from './adapterSecretRefs';
import { AdapterSecretService } from './adapterSecretService';

export type TenantDirectoryAuthConfig = {
  tenantName: string;
  authBaseUrl: string;
  tenantSsoToken: string;
  timeoutMs: number;
};

const readTenantSsoBlock = (tenant: Tenant): Record<string, unknown> => {
  const adapterConfig = asObject((tenant.adapterConfig as unknown) || {});
  const authBlock = asObject(getObjectValue(adapterConfig, 'auth'));
  return {
    ...asObject(getObjectValue(adapterConfig, 'sso')),
    ...asObject(getObjectValue(authBlock, 'sso')),
  };
};

const normalizeString = (value: unknown): string | null => {
  const text = String(value || '').trim();
  return text || null;
};

export const resolveTenantDirectoryAuthConfig = async (
  tenant: Tenant,
  secretService: AdapterSecretService,
): Promise<TenantDirectoryAuthConfig> => {
  const ssoBlock = readTenantSsoBlock(tenant);
  const authBaseUrl =
    normalizeString(getObjectValue(ssoBlock, 'authBaseUrl')) ||
    normalizeString(getObjectValue(ssoBlock, 'auth_base_url')) ||
    normalizeString(process.env.CORE_SSO_AUTH_BASE_URL);
  if (!authBaseUrl) {
    throw new Error('Tenant SSO authBaseUrl is required for organization adapter');
  }

  const tenantTokenSecretKey =
    normalizeString(getObjectValue(ssoBlock, 'tenantTokenSecretKey')) ||
    normalizeString(getObjectValue(ssoBlock, 'tenant_token_secret_key')) ||
    normalizeString(getObjectValue(ssoBlock, 'tenantSsoTokenSecretKey')) ||
    'auth:sso:tenant_token';
  const tenantSsoToken = await secretService.getSecretValue(tenant, tenantTokenSecretKey);
  if (!tenantSsoToken) {
    throw new Error(`Tenant SSO token is missing for tenant ${tenant.hostname}`);
  }

  const timeoutMs = Math.max(
    500,
    Number(
      getObjectValue(ssoBlock, 'orgDirectoryTimeoutMs') ||
        getObjectValue(ssoBlock, 'org_directory_timeout_ms') ||
        getObjectValue(ssoBlock, 'orgAdapterTimeoutMs') ||
        getObjectValue(ssoBlock, 'org_adapter_timeout_ms') ||
        5000,
    ) || 5000,
  );

  return {
    tenantName: tenant.hostname,
    authBaseUrl,
    tenantSsoToken,
    timeoutMs,
  };
};
