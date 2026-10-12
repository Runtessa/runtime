import { TenantRequest } from '../types/RequestContext';

const isTruthy = (value: unknown) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

export const isDeveloperAccess = (req: TenantRequest): boolean => {
  if (!req.tenant || !req.account || req.tokenPayload?.tenantId !== req.tenant.id) {
    return false;
  }
  const role = String(req.account.role ?? '').trim().toUpperCase();
  const studioPreview = req.tokenPayload.metadata?.purpose === 'studio-preview' &&
    req.tokenPayload.metadata?.previewRead === true;
  if (!studioPreview && role !== 'DEVELOPER' && role !== 'ADMIN') return false;

  const previewHeader = req.headers['x-dev-preview'];
  if (previewHeader !== undefined) {
    return isTruthy(previewHeader);
  }

  return true;
};
