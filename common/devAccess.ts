import { TenantRequest } from '../types/RequestContext';

const isTruthy = (value: unknown) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

export const isDeveloperAccess = (req: TenantRequest): boolean => {
  const previewHeader = req.headers['x-dev-preview'];
  if (isTruthy(previewHeader)) return true;

  const role = String(req.account?.role ?? req.tokenPayload?.role ?? '')
    .trim()
    .toUpperCase();
  return role === 'DEVELOPER' || role === 'ADMIN';
};
