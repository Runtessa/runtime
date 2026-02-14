import { NextFunction, Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { Tenant } from '@idp/shared';

export class AdminController {
  constructor(private readonly dataSource: DataSource) {}

  createTenant = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hostname, resourceConfig } = req.body ?? {};
      if (!hostname) {
        throw new AppError('hostname is required', 400);
      }

      const normalizedHost = String(hostname).toLowerCase();
      const config = this.normalizeResourceConfig(resourceConfig);

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

  private normalizeResourceConfig(input: unknown): { memory: number; timeout: number } {
    const defaults = { memory: 512, timeout: 5_000 };
    if (!input || typeof input !== 'object') {
      return defaults;
    }
    const memory = Number((input as Record<string, unknown>).memory) || defaults.memory;
    const timeout = Number((input as Record<string, unknown>).timeout) || defaults.timeout;
    return { memory, timeout };
  }
}
