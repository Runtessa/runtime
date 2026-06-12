export type RegistryScope = 'tenant' | 'global';

export const normalizeRequestedName = (raw: string | undefined) => {
  if (!raw) return '';
  let normalized = String(raw).trim();
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded.trim();
    } catch {
      break;
    }
  }
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized;
};

export const buildGlobalLookupNames = (name: string) => {
  const base = normalizeRequestedName(name);
  const values = new Set<string>();
  if (!base) return [] as string[];
  values.add(base);
  if (base.startsWith('@shared/')) {
    values.add(base.slice('@shared/'.length));
  } else if (!base.startsWith('@')) {
    values.add(`@shared/${base}`);
  }
  return Array.from(values);
};

export const buildTenantLookupNames = (name: string) => {
  const base = normalizeRequestedName(name);
  const values = new Set<string>();
  if (!base) return [] as string[];
  values.add(base);
  if (base.startsWith('@shared/')) {
    values.add(base.slice('@shared/'.length));
  }
  return Array.from(values);
};

export const buildCatalogAliases = (name: string, scope: RegistryScope) => {
  const aliases = scope === 'global'
    ? buildGlobalLookupNames(name)
    : buildTenantLookupNames(name);
  return Array.from(new Set([name, ...aliases]));
};

export const registryCacheKey = (
  scope: RegistryScope,
  tenantId: string | undefined,
  name: string,
  version: string
) => {
  const encoded = encodeURIComponent(name);
  if (scope === 'tenant' && tenantId) {
    return `registry:tenant:${tenantId}:${encoded}:${version}`;
  }
  return `registry:global:${encoded}:${version}`;
};
