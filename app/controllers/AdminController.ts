import { NextFunction, Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { Tenant } from '@idp/shared';
import {
  normalizeTenantHostname,
  normalizeTenantResourceConfig,
} from '../admin/tenantProvisioning';

export class AdminController {
  constructor(private readonly dataSource: DataSource) {}

  createTenant = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hostname, resourceConfig } = req.body ?? {};
      const normalizedHost = normalizeTenantHostname(hostname);
      const config = normalizeTenantResourceConfig(resourceConfig);

      const repo = this.dataSource.getRepository(Tenant);
      const existing = await repo.findOne({ where: { hostname: normalizedHost } });
      if (existing) {
        return res.status(409).json({ error: 'Tenant already exists' });
      }

      const tenant = repo.create({
        hostname: normalizedHost,
        resourceConfig: config,
        isSuspended: false,
      });

      await repo.save(tenant);
      res.status(201).json({
        id: tenant.id,
        hostname: tenant.hostname,
        resourceConfig: tenant.resourceConfig,
      });
    } catch (error) {
      next(error);
    }
  };

}
