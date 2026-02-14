import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { Tenant } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

export const TenantResolver =
  (dataSource: DataSource) => async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const hostname = (req.hostname || '').toLowerCase();
      if (!hostname) {
        throw new AppError('Hostname required to resolve tenant', 400);
      }

      const tenantRepo = dataSource.getRepository(Tenant);
      const tenant = await tenantRepo.findOne({ where: { hostname } });

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      if (tenant.isSuspended) {
        return res.status(403).json({ error: 'Tenant suspended' });
      }

      req.tenant = tenant;
      next();
    } catch (error) {
      next(error);
    }
  };
