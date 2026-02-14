import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { Tenant } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

const resolveTenant = async (
  dataSource: DataSource,
  req: TenantRequest,
  res: Response,
  { allowMissing }: { allowMissing: boolean }
) => {
  const headerOverride = (req.headers['x-tenant-host'] as string | undefined)
    ?.toLowerCase()
    .trim();
  const devFallback = process.env.DEV_TENANT_HOST?.toLowerCase().trim();

  let hostname = (req.hostname || '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    hostname = headerOverride || devFallback || hostname;
  }

  if (!hostname) {
    if (allowMissing) return null;
    throw new AppError('Hostname required to resolve tenant', 400);
  }

  const tenantRepo = dataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOne({ where: { hostname } });

  if (!tenant) {
    if (allowMissing) return null;
    res.status(404).json({ error: 'Tenant not found' });
    return null;
  }

  if (tenant.isSuspended) {
    res.status(403).json({ error: 'Tenant suspended' });
    return null;
  }

  if (!tenant.resourceConfig) {
    tenant.resourceConfig = { memory: 512, timeout: 5_000 };
  }

  return tenant;
};

export const ContextMiddleware =
  (dataSource: DataSource) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = await resolveTenant(dataSource, req, res, { allowMissing: false });
      if (!tenant) return;
      req.tenant = tenant;
      next();
    } catch (error) {
      next(error);
    }
  };

export const OptionalContextMiddleware =
  (dataSource: DataSource) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = await resolveTenant(dataSource, req, res, { allowMissing: true });
      if (tenant) {
        req.tenant = tenant;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
