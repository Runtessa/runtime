export interface AuthUserInfo {
  sub: string | null;
  email: string | null;
  given_name: string | null;
  family_name: string | null;
  role?: string | null;
  role_code?: string | null;
  roles?: string[] | null;
  groups?: string[] | null;
  organizations?: Array<{
    org_rand_id?: string | null;
    org_code?: string | null;
    org_name?: string | null;
    orgRandId?: string | null;
    orgCode?: string | null;
    orgName?: string | null;
  }> | null;
  tenant_org_rand_id?: string | null;
  tenantOrgRandId?: string | null;
  tenant_rand_id: string | null;
  tenant_name: string | null;
  tenant_code: string | null;
  client_id: string | null;
  scope: string | null;
}

export interface TenantSsoConfig {
  authBaseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  tenantSsoToken: string;
}

export interface TenantSsoOrgConfig {
  staticOrgRandId: string | null;
  orgIdQueryParam: string;
  orgIdHeader: string;
  adapterUrl: string | null;
  adapterTimeoutMs: number;
  adapterTokenSecretKey: string | null;
  adapterRequired: boolean;
}

export interface TenantOrgOption {
  orgRandId: string;
  code: string | null;
  name: string | null;
}
