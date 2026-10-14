import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { generateVersion } from '../../common/version';
import { publishedCache } from '../../core/publishedCache';
import { publishArtifact } from '../publication/publishArtifact';
import { HttpMethod, ModuleEntity, ModuleRevision, SourceCode, Tenant } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

export class ModuleController {
  constructor(private readonly dataSource: DataSource) {}

  list = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const modules = await repo.find({
        where: { tenant: { id: req.tenant!.id } },
        relations: ['sourceCode', 'publishedSourceCode'],
        order: { routePath: 'ASC', method: 'ASC' },
      });
      return res.json(modules.map((mod) => this.serialize(mod)));
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const mod = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
        relations: ['sourceCode', 'publishedSourceCode'],
      });
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }
      return res.json(this.serialize(mod));
    } catch (error) {
      next(error);
    }
  };

  create = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const { routePath, method, code } = req.body ?? {};
      const normalizedRoute = this.normalizeRoute(routePath);
      const normalizedMethod = this.normalizeMethod(method);
      const codeBody = this.normalizeCode(code);
      const fileExtension = this.normalizeFileExtension(req.body?.fileExtension);

      const repo = this.dataSource.getRepository(ModuleEntity);
      const sourceRepo = this.dataSource.getRepository(SourceCode);

      const existing = await repo.findOne({
        where: {
          tenant: { id: req.tenant!.id },
          routePath: normalizedRoute,
          method: normalizedMethod,
        },
      });
      if (existing) {
        return res.status(409).json({ error: 'Module already exists for route/method' });
      }

      const sourceCode = sourceRepo.create({ code: codeBody });
      await sourceRepo.save(sourceCode);

      const mod = repo.create({
        routePath: normalizedRoute,
        method: normalizedMethod,
        sourceCode,
        fileExtension,
        draftVersion: generateVersion(),
        tenant: req.tenant!,
      });
      await repo.save(mod);
      await this.ensureAclEndpoint(req.tenant as Tenant, normalizedRoute);
      return res.status(201).json(this.serialize(mod));
    } catch (error) {
      next(error);
    }
  };

  update = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const mod = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
        relations: ['sourceCode', 'publishedSourceCode'],
      });
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const nextRoute = req.body?.routePath ? this.normalizeRoute(req.body.routePath) : mod.routePath;
      const nextMethod = req.body?.method ? this.normalizeMethod(req.body.method) : mod.method;
      const nextCode =
        req.body?.code !== undefined
          ? this.normalizeCode(req.body.code)
          : this.requireModuleSourceCode(mod);
      const nextExt =
        req.body?.fileExtension !== undefined
          ? this.normalizeFileExtension(req.body.fileExtension)
          : mod.fileExtension;

      if (nextRoute !== mod.routePath || nextMethod !== mod.method) {
        const duplicate = await repo.findOne({
          where: {
            tenant: { id: req.tenant!.id },
            routePath: nextRoute,
            method: nextMethod,
          },
        });
        if (duplicate && duplicate.id !== mod.id) {
          return res.status(409).json({ error: 'Another module already uses this route/method' });
        }
      }

      await this.createRevision(req, mod, 'update');

      if (nextCode !== this.requireModuleSourceCode(mod)) {
        const sourceRepo = this.dataSource.getRepository(SourceCode);
        const sourceCode = sourceRepo.create({ code: nextCode });
        await sourceRepo.save(sourceCode);
        mod.sourceCode = sourceCode;
      }

      mod.routePath = nextRoute;
      mod.method = nextMethod;
      mod.fileExtension = nextExt;
      mod.draftVersion = generateVersion();
      await repo.save(mod);
      await this.ensureAclEndpoint(req.tenant as Tenant, nextRoute);

      return res.json(this.serialize(mod));
    } catch (error) {
      next(error);
    }
  };

  remove = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const mod = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
        relations: ['sourceCode', 'publishedSourceCode'],
      });
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }
      await this.createRevision(req, mod, 'delete');
      await this.clearPublishedCache(mod, req.tenant!.id);
      await repo.remove(mod);
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  listVersions = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const mod = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const revRepo = this.dataSource.getRepository(ModuleRevision);
      const revisions = await revRepo.find({
        where: { module: { id: mod.id } },
        relations: ['sourceCode'],
        order: { revision: 'DESC', createdAt: 'DESC' },
      });
      return res.json(revisions.map((rev) => this.serializeRevision(rev)));
    } catch (error) {
      next(error);
    }
  };

  rollback = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(ModuleEntity);
      const mod = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
        relations: ['sourceCode'],
      });
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const revRepo = this.dataSource.getRepository(ModuleRevision);
      const revision = await revRepo.findOne({
        where: { id: req.params.revisionId, module: { id: mod.id } },
        relations: ['sourceCode'],
      });
      if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
      }

      if (revision.routePath !== mod.routePath || revision.method !== mod.method) {
        const duplicate = await repo.findOne({
          where: {
            tenant: { id: req.tenant!.id },
            routePath: revision.routePath,
            method: revision.method,
          },
        });
        if (duplicate && duplicate.id !== mod.id) {
          return res.status(409).json({ error: 'Another module already uses this route/method' });
        }
      }

      await this.createRevision(req, mod, 'rollback');

      mod.routePath = revision.routePath;
      mod.method = revision.method;
      mod.sourceCode = this.requireRevisionSourceCodeEntity(revision);
      mod.fileExtension = revision.fileExtension;
      mod.draftVersion = generateVersion();
      await repo.save(mod);

      return res.json(this.serialize(mod));
    } catch (error) {
      next(error);
    }
  };

  publish = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const result = await publishArtifact(this.dataSource, 'module', req.tenant!.id, req.params.id);
      for (const key of result.cacheKeys) await publishedCache.del(key);
      return res.json(this.serialize(result.record));
    } catch (error) { next(error); }
  };

  private ensureTenant(req: TenantRequest) {
    if (!req.tenant) {
      throw new AppError('Tenant required', 400);
    }
  }

  private normalizeMethod(raw: unknown): HttpMethod {
    if (typeof raw !== 'string') {
      throw new AppError('method is required', 400);
    }
    const upper = raw.toUpperCase();
    if (!Object.values(HttpMethod).includes(upper as HttpMethod)) {
      throw new AppError('Invalid HTTP method', 400);
    }
    return upper as HttpMethod;
  }

  private normalizeRoute(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new AppError('routePath is required', 400);
    }
    const normalized = raw.trim().startsWith('/') ? raw.trim() : `/${raw.trim()}`;
    return normalized;
  }

  private normalizeCode(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new AppError('code is required', 400);
    }
    return raw;
  }

  private normalizeFileExtension(raw: unknown): string {
    const allowed = new Set(['js']);
    if (!raw || typeof raw !== 'string') return 'js';
    const normalized = raw.replace(/^\./, '').toLowerCase();
    return allowed.has(normalized) ? normalized : 'js';
  }

  private async createRevision(req: TenantRequest, mod: ModuleEntity, action: string) {
    const revRepo = this.dataSource.getRepository(ModuleRevision);
    const last = await revRepo.findOne({
      where: { module: { id: mod.id } },
      order: { revision: 'DESC' },
    });
    const revision = revRepo.create({
      module: mod,
      tenant: req.tenant!,
      revision: (last?.revision ?? 0) + 1,
      routePath: mod.routePath,
      method: mod.method,
      sourceCode: this.requireModuleSourceCodeEntity(mod),
      fileExtension: mod.fileExtension,
      action,
      createdBy: req.account?.id ?? null,
    });
    await revRepo.save(revision);
  }

  private async ensureAclEndpoint(tenant: Tenant, routePath: string) {
    const endpoints = (tenant.aclEndpoints ?? {}) as Record<
      string,
      { read?: string[]; write?: string[]; edit?: string[]; delete?: string[]; allowAnonymous?: boolean }
    >;
    if (endpoints[routePath]) return;
    endpoints[routePath] = {
      read: [],
      write: [],
      edit: [],
      delete: [],
      allowAnonymous: false,
    };
    tenant.aclEndpoints = endpoints as Tenant['aclEndpoints'];
    const tenantRepo = this.dataSource.getRepository(Tenant);
    await tenantRepo.save(tenant);
  }

  private moduleCacheKey(tenantId: string, method: HttpMethod) {
    return `module:published:${tenantId}:${method}`;
  }

  private async clearPublishedCache(mod: ModuleEntity, tenantId: string) {
    const method = mod.publishedMethod ?? mod.method;
    await publishedCache.del(this.moduleCacheKey(tenantId, method));
  }

  private serialize(mod: ModuleEntity) {
    return {
      id: mod.id,
      routePath: mod.routePath,
      method: mod.method,
      code: this.requireModuleSourceCode(mod),
      fileExtension: mod.fileExtension,
      draftVersion: mod.draftVersion,
      publishedVersion: mod.publishedVersion ?? undefined,
      publishedAt: mod.publishedAt ?? undefined,
      createdAt: mod.createdAt,
      updatedAt: mod.updatedAt,
    };
  }

  private serializeRevision(rev: ModuleRevision) {
    return {
      id: rev.id,
      revision: rev.revision,
      routePath: rev.routePath,
      method: rev.method,
      code: this.requireRevisionSourceCode(rev),
      fileExtension: rev.fileExtension,
      action: rev.action,
      createdBy: rev.createdBy ?? undefined,
      createdAt: rev.createdAt,
    };
  }

  private requireModuleSourceCodeEntity(mod: ModuleEntity) {
    if (!mod.sourceCode) {
      throw new AppError(`Module ${mod.id} is missing source code`, 500);
    }
    return mod.sourceCode;
  }

  private requireModuleSourceCode(mod: ModuleEntity) {
    const sourceCode = this.requireModuleSourceCodeEntity(mod);
    return sourceCode.code;
  }

  private requireRevisionSourceCode(rev: ModuleRevision) {
    const sourceCode = this.requireRevisionSourceCodeEntity(rev);
    return sourceCode.code;
  }

  private requireRevisionSourceCodeEntity(rev: ModuleRevision) {
    if (!rev.sourceCode) {
      throw new AppError(`Module revision ${rev.id} is missing source code`, 500);
    }
    return rev.sourceCode;
  }
}
