import { Tenant } from '@idp/shared';

export type TenantPwaConfig = {
  enabled: boolean;
  name: string;
  shortName: string;
  description?: string;
  themeColor: string;
  backgroundColor: string;
  display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  startUrl: string;
  scope: string;
  icons: Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
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

const isSafeAssetUrl = (value: string) =>
  value.startsWith('/') || value.startsWith('data:image/') || /^https?:\/\//i.test(value);

const normalizeAssetUrl = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed && isSafeAssetUrl(trimmed) ? trimmed : '';
};

const normalizePath = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/')) return fallback;
  return trimmed;
};

const normalizeColor = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) ? trimmed : fallback;
};

const normalizeDisplay = (value: unknown): TenantPwaConfig['display'] => {
  if (value === 'fullscreen' || value === 'minimal-ui' || value === 'browser') return value;
  return 'standalone';
};

const buildFallbackIcon = (name: string, backgroundColor: string) => {
  const initials = firstString(name)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'A';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${backgroundColor}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-size="192" font-weight="700" fill="#f5f5f5">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const normalizeIcons = (raw: unknown, fallbackIcon: string) => {
  const source = Array.isArray(raw) ? raw : [];
  const icons = source
    .map((item) => {
      const icon = asObject(item);
      const src = normalizeAssetUrl(icon.src);
      const sizes = firstString(icon.sizes) || '192x192';
      if (!src) return null;
      return {
        src,
        sizes,
        type: firstString(icon.type) || undefined,
        purpose: firstString(icon.purpose) || 'any maskable',
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (icons.length > 0) return icons;
  if (!fallbackIcon) return [];
  return [
    { src: fallbackIcon, sizes: '192x192', purpose: 'any' },
    { src: fallbackIcon, sizes: '512x512', purpose: 'any' },
  ];
};

export const resolveTenantPwaConfig = (tenant?: Tenant | null): TenantPwaConfig | null => {
  const pwa = asObject(tenant?.pwaConfig);
  const adapterConfig = asObject(tenant?.adapterConfig);
  const settings = asObject(adapterConfig.settings);
  const legacyPwa = asObject(settings.pwa);
  const source = { ...legacyPwa, ...pwa };
  if (source.enabled !== true) return null;

  const branding = { ...asObject(adapterConfig.branding), ...asObject(asObject(settings).branding) };
  const name = firstString(source.name, source.appName, branding.title, branding.name, tenant?.hostname) || 'Tenant App';
  const shortName = firstString(source.shortName, source.short_name, name).slice(0, 32) || name;
  const backgroundColor = normalizeColor(source.backgroundColor ?? source.background_color, '#121212');
  const fallbackIcon =
    normalizeAssetUrl(
      firstString(source.icon, source.iconUrl, branding.faviconUrl, branding.favicon, branding.iconUrl)
    ) || buildFallbackIcon(name, backgroundColor);

  return {
    enabled: true,
    name,
    shortName,
    description: firstString(source.description) || undefined,
    themeColor: normalizeColor(source.themeColor ?? source.theme_color, '#121212'),
    backgroundColor,
    display: normalizeDisplay(source.display),
    startUrl: normalizePath(source.startUrl ?? source.start_url, '/'),
    scope: normalizePath(source.scope, '/'),
    icons: normalizeIcons(source.icons, fallbackIcon),
  };
};

export const buildTenantPwaManifest = (tenant?: Tenant | null) => {
  const config = resolveTenantPwaConfig(tenant);
  if (!config) return null;
  return {
    name: config.name,
    short_name: config.shortName,
    description: config.description,
    start_url: config.startUrl,
    scope: config.scope,
    display: config.display,
    theme_color: config.themeColor,
    background_color: config.backgroundColor,
    icons: config.icons,
  };
};

export const buildTenantServiceWorker = (tenant?: Tenant | null) => {
  const config = resolveTenantPwaConfig(tenant);
  if (!config) return null;
  const cacheName = `idp-tenant-shell-${tenant?.id || 'default'}-${tenant?.updatedAt?.getTime?.() || Date.now()}`;
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const SHELL_URLS = ['/', '/bundle.js', '/kernel-source.js'];
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => undefined)))).catch(() => undefined));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('idp-tenant-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  event.respondWith(fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match('/'))));
});
`;
};
