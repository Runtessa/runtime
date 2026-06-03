import { Tenant } from "@idp/shared";

const hasExplicitVersion = (value: string) => /[?&](?:v|ver|version)=/i.test(value);

const resolveTenantVersionToken = (tenant?: Tenant | null) => {
  const timestamp = tenant?.updatedAt?.getTime?.();
  return Number.isFinite(timestamp) && timestamp! > 0 ? String(timestamp) : "";
};

export const withTenantAssetVersion = (value: string | null | undefined, tenant?: Tenant | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || hasExplicitVersion(trimmed)) {
    return trimmed || null;
  }

  const version = resolveTenantVersionToken(tenant);
  if (!version) return trimmed;

  const separator = trimmed.includes("?") ? "&" : "?";
  return `${trimmed}${separator}v=${encodeURIComponent(version)}`;
};
