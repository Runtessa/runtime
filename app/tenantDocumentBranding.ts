import { Tenant } from '@idp/shared';
import { resolveTenantPwaConfig } from './tenantPwa';
import { withTenantAssetVersion } from './tenantAssetVersion';

type TenantDocumentBranding = {
  title: string;
  faviconUrl: string | null;
  appleTouchIconUrl: string | null;
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isSafeIconUrl = (value: string) =>
  value.startsWith('/') ||
  value.startsWith('data:image/') ||
  /^https?:\/\//i.test(value);

const normalizeIconUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || !isSafeIconUrl(trimmed)) return null;
  return trimmed;
};

export const resolveTenantDocumentBranding = (tenant?: Tenant | null): TenantDocumentBranding => {
  const adapterConfig = asObject(tenant?.adapterConfig);
  const tenantBranding = asObject((tenant as any)?.brandingConfig);
  const settings = asObject(adapterConfig.settings);
  const branding = {
    ...asObject(settings.branding),
    ...asObject(adapterConfig.branding),
    ...tenantBranding,
  };
  const ui = {
    ...asObject(settings.ui),
    ...asObject(adapterConfig.ui),
  };

  const title =
    firstString(
      branding.title,
      branding.appTitle,
      branding.displayName,
      branding.name,
      ui.title,
      ui.appTitle,
      adapterConfig.title,
      adapterConfig.appTitle
    ) ||
    tenant?.hostname ||
    'Server-Driven Micro-Frontend';

  const faviconUrl = normalizeIconUrl(
    firstString(
      branding.faviconUrl,
      branding.favicon,
      branding.iconUrl,
      branding.icon,
      ui.faviconUrl,
      ui.favicon,
      adapterConfig.faviconUrl,
      adapterConfig.favicon
    )
  );

  const appleTouchIconUrl = normalizeIconUrl(
    firstString(
      branding.appleTouchIconUrl,
      branding.appleTouchIcon,
      ui.appleTouchIconUrl,
      ui.appleTouchIcon
    )
  );

  return { title, faviconUrl, appleTouchIconUrl };
};

export const applyTenantDocumentBranding = (html: string, tenant?: Tenant | null) => {
  const branding = resolveTenantDocumentBranding(tenant);
  const faviconUrl = withTenantAssetVersion(branding.faviconUrl, tenant);
  const appleTouchIconUrl = withTenantAssetVersion(branding.appleTouchIconUrl, tenant);
  const manifestUrl = resolveTenantPwaConfig(tenant)
    ? withTenantAssetVersion('/manifest.webmanifest', tenant)
    : null;
  let nextHtml = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(branding.title)}</title>`
  );

  nextHtml = nextHtml.replace(/<link\s+[^>]*rel=["']manifest["'][^>]*>\s*/gi, '');

  const iconLinks = [
    manifestUrl ? `<link rel="manifest" href="${escapeHtml(manifestUrl)}" />` : '',
    faviconUrl
      ? `<link rel="icon" href="${escapeHtml(faviconUrl)}" />`
      : '',
    appleTouchIconUrl
      ? `<link rel="apple-touch-icon" href="${escapeHtml(appleTouchIconUrl)}" />`
      : '',
  ].filter(Boolean);

  if (iconLinks.length === 0) return nextHtml;

  nextHtml = nextHtml.replace(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>\s*/gi, '');
  nextHtml = nextHtml.replace(/<link\s+[^>]*rel=["']apple-touch-icon["'][^>]*>\s*/gi, '');
  return nextHtml.replace(/<\/head>/i, `  ${iconLinks.join('\n  ')}\n</head>`);
};
