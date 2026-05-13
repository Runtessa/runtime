import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { generateVersion } from '../../common/version';
import { publishedCache } from '../../core/publishedCache';
import { UIPackage, UIPackageRevision, SourceCode, CompiledCode } from '@idp/shared';
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
        relations: ['sourceCode', 'compiledCode'],
      });
      return res.json(packages.map((pkg) => this.serialize(pkg)));
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
        relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
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
      const { name, version, code, codeBlob, dependencies } = req.body ?? {};
      const normalizedName = this.normalizeName(name);
      const normalizedVersion = this.normalizeVersion(version);
      const normalizedCode = this.normalizeSourceCode(code);
      const compiledCode = this.normalizeCompiledCode(codeBlob);
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

      const sourceCodeRepo = this.dataSource.getRepository(SourceCode);
      const compiledCodeRepo = this.dataSource.getRepository(CompiledCode);
      const sc = sourceCodeRepo.create({ code: normalizedCode });
      const cc = compiledCodeRepo.create({ code: compiledCode });
      await sourceCodeRepo.save(sc);
      await compiledCodeRepo.save(cc);

      const pkg = repo.create({
        name: normalizedName,
        version: normalizedVersion,
        sourceCode: sc,
        compiledCode: cc,
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
        relations: ['sourceCode', 'compiledCode'],
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      const nextName = req.body?.name ? this.normalizeName(req.body.name) : pkg.name;
      const nextVersion = req.body?.version ? this.normalizeVersion(req.body.version) : pkg.version;
      const nextSourceCode =
        req.body?.code !== undefined
          ? this.normalizeSourceCode(req.body.code)
          : this.requireSourceCode(pkg);
      const nextCompiledCode =
        req.body?.codeBlob !== undefined
          ? this.normalizeCompiledCode(req.body.codeBlob)
          : this.requireCompiledCode(pkg);
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

      const sourceCodeRepo = this.dataSource.getRepository(SourceCode);
      const compiledCodeRepo = this.dataSource.getRepository(CompiledCode);
      const sc = sourceCodeRepo.create({ code: nextSourceCode });
      const cc = compiledCodeRepo.create({ code: nextCompiledCode });
      await sourceCodeRepo.save(sc);
      await compiledCodeRepo.save(cc);

      pkg.name = nextName;
      pkg.version = nextVersion;
      pkg.sourceCode = sc;
      pkg.compiledCode = cc;
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
        relations: ['sourceCode', 'compiledCode'],
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
        relations: ['sourceCode', 'compiledCode'],
      });
      return res.json(revisions.map((rev) => this.serializeRevision(rev)));
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
        relations: ['sourceCode', 'compiledCode'],
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }
      const revRepo = this.dataSource.getRepository(UIPackageRevision);
      const revision = await revRepo.findOne({
        where: { id: req.params.revisionId, uiPackage: { id: pkg.id } },
        relations: ['sourceCode', 'compiledCode'],
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
      pkg.sourceCode = revision.sourceCode;
      pkg.compiledCode = revision.compiledCode;
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
        relations: ['sourceCode', 'compiledCode'],
      });
      if (!pkg) {
        return res.status(404).json({ error: 'UI entity not found' });
      }

      pkg.publishedVersion = generateVersion();
      pkg.publishedSourceCode = pkg.sourceCode;
      pkg.publishedCompiledCode = pkg.compiledCode;
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
        sourceCode: this.requireSourceCodeEntity(pkg),
        compiledCode: this.requireCompiledCodeEntity(pkg),
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
      code: this.requireSourceCode(pkg),
      codeBlob: this.requireCompiledCode(pkg),
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
      code: this.requireRevisionSourceCode(rev),
      codeBlob: this.requireRevisionCompiledCode(rev),
      dependencies: rev.dependencies ?? [],
      fileExtension: rev.fileExtension,
      action: rev.action,
      createdBy: rev.createdBy ?? undefined,
      createdAt: rev.createdAt,
    };
  }

  private requireSourceCodeEntity(pkg: UIPackage) {
    if (!pkg.sourceCode) {
      throw new AppError(`UI package ${pkg.id} is missing source code`, 500);
    }
    return pkg.sourceCode;
  }

  private requireSourceCode(pkg: UIPackage) {
    return this.requireSourceCodeEntity(pkg).code;
  }

  private requireCompiledCodeEntity(pkg: UIPackage) {
    if (!pkg.compiledCode) {
      throw new AppError(`UI package ${pkg.id} is missing compiled code`, 500);
    }
    return pkg.compiledCode;
  }

  private requireCompiledCode(pkg: UIPackage) {
    return this.requireCompiledCodeEntity(pkg).code;
  }

  private requireRevisionSourceCode(rev: UIPackageRevision) {
    if (!rev.sourceCode) {
      throw new AppError(`UI revision ${rev.id} is missing source code`, 500);
    }
    return rev.sourceCode.code;
  }

  private requireRevisionCompiledCode(rev: UIPackageRevision) {
    if (!rev.compiledCode) {
      throw new AppError(`UI revision ${rev.id} is missing compiled code`, 500);
    }
    return rev.compiledCode.code;
  }
}
