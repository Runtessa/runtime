import { RequestHandler } from 'express';
import { resolveTenantDocumentBranding } from '../tenantDocumentBranding';
import { resolveTenantPwaConfig } from '../tenantPwa';
import { resolveTenantSsoConfig } from '../../core/security/ssoHelpers';
import { TenantRequest } from '../../types/RequestContext';
import { readReturnTo, redirectIfTenantSessionActive } from './authSsoRouteUtils';
import { AuthSsoRuntimeOptions } from './authSsoRouteTypes';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderTenantLoginPage = (tenantReq: TenantRequest, options: {
  returnTo: string;
  ssoReady: boolean;
  errorMessage: string | null;
}) => {
  const branding = resolveTenantDocumentBranding(tenantReq.tenant);
  const pwa = resolveTenantPwaConfig(tenantReq.tenant);
  const accent = pwa?.themeColor || '#1f6feb';
  const surface = pwa?.backgroundColor || '#0f172a';
  const title = branding.title || tenantReq.tenant?.hostname || 'Tenant';
  const hostname = tenantReq.tenant?.hostname || 'tenant';
  const favicon = branding.faviconUrl || branding.appleTouchIconUrl || '';
  const titleLetter = title.trim().charAt(0).toUpperCase() || 'T';
  const helperText = options.ssoReady
    ? 'Authentication stays centralized in the auth service. This tenant page only owns the experience.'
    : options.errorMessage || 'Single sign-on is not configured for this tenant.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | Sign in</title>
  ${favicon ? `<link rel="icon" href="${escapeHtml(favicon)}" />` : ''}
  <style>
    :root { color-scheme: light; --accent: ${escapeHtml(accent)}; --surface: ${escapeHtml(surface)}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(160deg, #f8fafc 0%, #eef2ff 45%, #e2e8f0 100%); color: #0f172a; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .shell { width: min(100%, 980px); display: grid; gap: 24px; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 420px); }
    .panel, .card { border-radius: 28px; background: rgba(255,255,255,0.92); border: 1px solid rgba(148,163,184,0.24); box-shadow: 0 24px 70px rgba(15,23,42,0.12); backdrop-filter: blur(14px); }
    .panel { padding: 32px; position: relative; overflow: hidden; }
    .card { padding: 28px; }
    .kicker { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px; background: rgba(255,255,255,0.72); border: 1px solid rgba(148,163,184,0.24); color: #334155; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
    .brand-mark { width: 56px; height: 56px; border-radius: 18px; background: linear-gradient(145deg, var(--accent), var(--surface)); display: grid; place-items: center; color: white; font-weight: 700; font-size: 22px; overflow: hidden; }
    .brand-mark img { width: 100%; height: 100%; object-fit: cover; }
    h1 { margin: 22px 0 12px; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.02; letter-spacing: -0.04em; }
    p { margin: 0; color: #475569; font-size: 15px; line-height: 1.7; }
    .meta { margin-top: 28px; display: grid; gap: 14px; }
    .meta-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-radius: 18px; background: rgba(248,250,252,0.92); border: 1px solid rgba(148,163,184,0.18); }
    .meta-label { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .meta-value { color: #0f172a; font-weight: 600; font-size: 14px; }
    .card h2 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.03em; }
    .card-copy { margin-bottom: 22px; }
    form { display: grid; gap: 16px; }
    button { width: 100%; border: 0; border-radius: 18px; padding: 15px 18px; font-size: 15px; font-weight: 700; cursor: pointer; background: linear-gradient(135deg, var(--accent), var(--surface)); color: white; box-shadow: 0 18px 32px rgba(15,23,42,0.16); }
    button[disabled] { cursor: not-allowed; opacity: 0.55; box-shadow: none; }
    .return-to { padding: 12px 14px; border-radius: 16px; background: #f8fafc; border: 1px solid rgba(148,163,184,0.18); color: #334155; font-size: 13px; }
    .alert { padding: 14px 16px; border-radius: 16px; background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; font-size: 14px; }
    .hint { color: #64748b; font-size: 13px; line-height: 1.6; }
    .actions { display: grid; gap: 10px; }
    @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .panel, .card { padding: 24px; } }
  </style>
</head>
<body>
  <main>
    <section class="shell">
      <article class="panel">
        <span class="kicker">Tenant Sign-in Surface</span>
        <div style="margin-top:20px" class="brand-mark">${favicon ? `<img src="${escapeHtml(favicon)}" alt="${escapeHtml(title)}" />` : escapeHtml(titleLetter)}</div>
        <h1>${escapeHtml(title)}</h1>
        <p>Use your organization single sign-on to enter this tenant. The tenant owns this page. The auth service only handles the secure handshake.</p>
        <div class="meta">
          <div class="meta-row"><span class="meta-label">Tenant host</span><span class="meta-value">${escapeHtml(hostname)}</span></div>
          <div class="meta-row"><span class="meta-label">Flow</span><span class="meta-value">Centralized SSO with tenant return</span></div>
          <div class="meta-row"><span class="meta-label">Destination</span><span class="meta-value">${escapeHtml(options.returnTo)}</span></div>
        </div>
      </article>
      <aside class="card">
        <h2>Continue to your workspace</h2>
        <p class="card-copy">${escapeHtml(helperText)}</p>
        ${options.errorMessage ? `<div class="alert">${escapeHtml(options.errorMessage)}</div>` : ''}
        <form action="/auth/start" method="get">
          <input type="hidden" name="returnTo" value="${escapeHtml(options.returnTo)}" />
          <div class="return-to">After sign-in, you will return to <strong>${escapeHtml(options.returnTo)}</strong>.</div>
          <div class="actions">
            <button type="submit" ${options.ssoReady ? '' : 'disabled'}>Continue with SSO</button>
          </div>
        </form>
        <p class="hint">If this tenant should have a custom login design, keep it here in core. Do not move OAuth or session issuance out of auth.</p>
      </aside>
    </section>
  </main>
</body>
</html>`;
};

export const createTenantLoginPageHandler = (
  options: Pick<AuthSsoRuntimeOptions, 'tenantSessionStore' | 'sessionCookieName' | 'ssoEnabled' | 'cryptoService' | 'authBaseUrl' | 'scope'>,
): RequestHandler => {
  return async (req, res, next) => {
    try {
      const tenantReq = req as TenantRequest;
      if (!tenantReq.tenant) {
        return res.status(400).send('Tenant required');
      }

      const returnTo = readReturnTo(req);
      if (await redirectIfTenantSessionActive(req, res, tenantReq, options, returnTo)) {
        return;
      }

      if (String(req.query.direct || '').trim() === '1') {
        return res.redirect(`/auth/start?returnTo=${encodeURIComponent(returnTo)}`);
      }

      let errorMessage: string | null = null;
      let ssoReady = options.ssoEnabled;
      if (ssoReady) {
        try {
          await resolveTenantSsoConfig(tenantReq, options.cryptoService, {
            authBaseUrl: options.authBaseUrl,
            scope: options.scope,
          });
        } catch {
          ssoReady = false;
          errorMessage = 'Single sign-on is not fully configured for this tenant.';
        }
      } else {
        errorMessage = 'Single sign-on is not configured on the core service.';
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(ssoReady ? 200 : 503).send(
        renderTenantLoginPage(tenantReq, { returnTo, ssoReady, errorMessage }),
      );
    } catch (error) {
      next(error);
    }
  };
};
