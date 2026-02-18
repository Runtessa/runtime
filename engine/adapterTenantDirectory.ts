import { TenantDirectoryOrgResponse, TenantDirectoryOuResponse, TenantDirectoryUsersResponse } from './adapterTypes';

export interface TenantDirectoryAuthConfig {
  tenantName: string;
  authBaseUrl: string;
  tenantSsoToken: string;
  timeoutMs: number;
}

export const createTenantDirectoryAdapter = (
  readConfig: () => Promise<TenantDirectoryAuthConfig>,
): {
  getOrg: () => Promise<TenantDirectoryOrgResponse>;
  getOU: (ouPath: string) => Promise<TenantDirectoryOuResponse>;
  getUsers: (ouPath: string) => Promise<TenantDirectoryUsersResponse>;
} => {
  const request = async <T>(
    endpointPath: string,
    query: Record<string, string | null | undefined> = {},
  ): Promise<T> => {
    const config = await readConfig();
    const url = new URL(endpointPath, config.authBaseUrl);
    url.searchParams.set('tenant_name', config.tenantName);
    Object.entries(query).forEach(([key, value]) => {
      const normalized = String(value || '').trim();
      if (normalized) {
        url.searchParams.set(key, normalized);
      }
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Tenant-Sso-Token': config.tenantSsoToken,
          'X-Tenant-Name': config.tenantName,
        },
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          String(payload.error || `Auth directory request failed (${response.status})`),
        );
      }
      return payload as unknown as T;
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  return {
    getOrg: () => request<TenantDirectoryOrgResponse>('/api/tenant-directory/org'),
    getOU: (ouPath: string) =>
      request<TenantDirectoryOuResponse>('/api/tenant-directory/ou', {
        ou_path: ouPath || '',
      }),
    getUsers: (ouPath: string) =>
      request<TenantDirectoryUsersResponse>('/api/tenant-directory/users', {
        ou_path: ouPath || '',
      }),
  };
};
