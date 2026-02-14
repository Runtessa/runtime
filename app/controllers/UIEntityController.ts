import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { generateVersion } from '../../common/version';
import { publishedCache } from '../../core/publishedCache';
import { UIPackage } from '@idp/shared';
import { UIPackageRevision } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

export class UIEntityController {
  constructor(private readonly dataSource: DataSource) {}

  list = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const packages = await repo.find({
        where: { tenant: { id: req.tenant!.id } },
        order: { name: 'ASC', version: 'DESC' },
      });
      return res.json(packages.map(this.serialize));
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      return res.json(this.serialize(pkg));
    } catch (error) {
      next(error);
    }
  };

  create = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const { name, version, codeBlob, dependencies } = req.body ?? {};
      const normalizedName = this.normalizeName(name);
      const normalizedVersion = this.normalizeVersion(version);
      const normalizedCode = this.normalizeSourceCode(req.body?.code ?? codeBlob);
      const compiledCode = this.normalizeCompiledCode(req.body?.codeBlob ?? codeBlob ?? normalizedCode);
      const normalizedDeps = this.normalizeDependencies(dependencies);
      const fileExtension = this.normalizeFileExtension(req.body?.fileExtension);

      const repo = this.dataSource.getRepository(UIPackage);
      const existing = await repo.findOne({
        where: {
          tenant: { id: req.tenant!.id },
          name: normalizedName,
          version: normalizedVersion,
        },
      });
      if (existing) {
        return res.status(409).json({ error: 'UI entity already exists with this name/version' });
      }

      const pkg = repo.create({
        name: normalizedName,
        version: normalizedVersion,
        code: normalizedCode,
        codeBlob: compiledCode,
        dependencies: normalizedDeps,
        fileExtension,
        draftVersion: generateVersion(),
        tenant: req.tenant!,
      });
      await repo.save(pkg);
      return res.status(201).json(this.serialize(pkg));
    } catch (error) {
      next(error);
    }
  };

  update = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      const nextName = req.body?.name ? this.normalizeName(req.body.name) : pkg.name;
      const nextVersion = req.body?.version ? this.normalizeVersion(req.body.version) : pkg.version;
      const nextSource =
        req.body?.code !== undefined
          ? this.normalizeSourceCode(req.body.code)
          : pkg.code;
      const nextCompiled =
        req.body?.codeBlob !== undefined
          ? this.normalizeCompiledCode(req.body.codeBlob)
          : pkg.codeBlob;
      const nextDeps =
        req.body?.dependencies !== undefined
          ? this.normalizeDependencies(req.body.dependencies)
          : pkg.dependencies ?? [];
      const nextExt =
        req.body?.fileExtension !== undefined
          ? this.normalizeFileExtension(req.body.fileExtension)
          : pkg.fileExtension;
      if (nextName !== pkg.name || nextVersion !== pkg.version) {
        const duplicate = await repo.findOne({
          where: {
            tenant: { id: req.tenant!.id },
            name: nextName,
            version: nextVersion,
          },
        });
        if (duplicate && duplicate.id !== pkg.id) {
          return res.status(409).json({ error: 'Another UI entity already uses this name/version' });
        }
      }

      await this.createRevision(req, pkg, 'update');

      pkg.name = nextName;
      pkg.version = nextVersion;
      pkg.code = nextSource;
      pkg.codeBlob = nextCompiled;
      pkg.dependencies = nextDeps;
      pkg.fileExtension = nextExt;
      pkg.draftVersion = generateVersion();
      await repo.save(pkg);

      return res.json(this.serialize(pkg));
    } catch (error) {
      next(error);
    }
  };

  remove = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      await this.createRevision(req, pkg, 'delete');
      await this.clearPublishedCache(pkg, req.tenant!.id);
      await repo.remove(pkg);
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  listVersions = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      const revRepo = this.dataSource.getRepository(UIPackageRevision);
      const revisions = await revRepo.find({
        where: { uiPackage: { id: pkg.id } },
        order: { revision: 'DESC', createdAt: 'DESC' },
      });
      return res.json(revisions.map(this.serializeRevision));
    } catch (error) {
      next(error);
    }
  };

  rollback = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      const revRepo = this.dataSource.getRepository(UIPackageRevision);
      const revision = await revRepo.findOne({
        where: { id: req.params.revisionId, uiPackage: { id: pkg.id } },
      });
      if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
      }

      if (revision.name !== pkg.name || revision.version !== pkg.version) {
        const duplicate = await repo.findOne({
          where: {
            tenant: { id: req.tenant!.id },
            name: revision.name,
            version: revision.version,
          },
        });
        if (duplicate && duplicate.id !== pkg.id) {
          return res.status(409).json({ error: 'Another UI entity already uses this name/version' });
        }
      }

      await this.createRevision(req, pkg, 'rollback');

      pkg.name = revision.name;
      pkg.version = revision.version;
      pkg.code = revision.code;
      pkg.codeBlob = revision.codeBlob;
      pkg.dependencies = revision.dependencies ?? [];
      pkg.fileExtension = revision.fileExtension;
      pkg.draftVersion = generateVersion();
      await repo.save(pkg);

      return res.json(this.serialize(pkg));
    } catch (error) {
      next(error);
    }
  };

  publish = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      this.ensureTenant(req);
      const repo = this.dataSource.getRepository(UIPackage);
      const pkg = await repo.findOne({
        where: { id: req.params.id, tenant: { id: req.tenant!.id } },
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }

      pkg.publishedVersion = generateVersion();
      pkg.publishedCode = pkg.code;
      pkg.publishedCodeBlob = pkg.codeBlob;
      pkg.publishedDependencies = pkg.dependencies ?? [];
      pkg.publishedFileExtension = pkg.fileExtension;
      pkg.publishedAt = new Date();
      await repo.save(pkg);

      await publishedCache.del(this.registryCacheKey(req.tenant!.id, pkg.name, 'latest'));
      await publishedCache.del(this.registryCacheKey(req.tenant!.id, pkg.name, pkg.version));

      return res.json(this.serialize(pkg));
    } catch (error) {
      next(error);
    }
  };

  private ensureTenant(req: TenantRequest) {
    if (!req.tenant) {
      throw new AppError('Tenant required', 400);
    }
  }

  private normalizeName(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new AppError('name is required', 400);
    }
    return raw.trim();
  }

  private normalizeVersion(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new AppError('version is required', 400);
    }
    return raw.trim();
  }

  private normalizeSourceCode(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new AppError('code is required', 400);
    }
    return raw;
  }

  private normalizeCompiledCode(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new AppError("codeBlob (compiled output) is required", 400);
    }
    return raw;
  }

  private normalizeDependencies(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new AppError('dependencies must be an array', 400);
    }
    return raw.map((item) => String(item));
  }

  private normalizeFileExtension(raw: unknown): string {
    const allowed = new Set(['jsx', 'js', 'json', 'css']);
    if (!raw || typeof raw !== 'string') return 'jsx';
    const normalized = raw.replace(/^\./, '').toLowerCase();
    return allowed.has(normalized) ? normalized : 'jsx';
  }

  private async createRevision(req: TenantRequest, pkg: UIPackage, action: string) {
    const revRepo = this.dataSource.getRepository(UIPackageRevision);
    const last = await revRepo.findOne({
      where: { uiPackage: { id: pkg.id } },
      order: { revision: 'DESC' },
    });
    const revision = revRepo.create({
      uiPackage: pkg,
      tenant: req.tenant!,
      revision: (last?.revision ?? 0) + 1,
      name: pkg.name,
      version: pkg.version,
      code: pkg.code,
      codeBlob: pkg.codeBlob,
      dependencies: pkg.dependencies ?? [],
      fileExtension: pkg.fileExtension,
      action,
      createdBy: req.account?.id ?? null,
    });
    await revRepo.save(revision);
  }

  private registryCacheKey(tenantId: string, name: string, version: string) {
    return `registry:tenant:${tenantId}:${encodeURIComponent(name)}:${version}`;
  }

  private async clearPublishedCache(pkg: UIPackage, tenantId: string) {
    await publishedCache.del(this.registryCacheKey(tenantId, pkg.name, 'latest'));
    await publishedCache.del(this.registryCacheKey(tenantId, pkg.name, pkg.version));
  }

  private serialize(pkg: UIPackage) {
    return {
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      code: pkg.code,
      codeBlob: pkg.codeBlob,
      dependencies: pkg.dependencies ?? [],
      fileExtension: pkg.fileExtension,
      draftVersion: pkg.draftVersion,
      publishedVersion: pkg.publishedVersion ?? undefined,
      publishedAt: pkg.publishedAt ?? undefined,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
    };
  }

  private serializeRevision(rev: UIPackageRevision) {
    return {
      id: rev.id,
      revision: rev.revision,
      name: rev.name,
      version: rev.version,
      code: rev.code,
      codeBlob: rev.codeBlob,
      dependencies: rev.dependencies ?? [],
      fileExtension: rev.fileExtension,
      action: rev.action,
      createdBy: rev.createdBy ?? undefined,
      createdAt: rev.createdAt,
    };
  }
}
