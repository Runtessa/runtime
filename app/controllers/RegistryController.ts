import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { isDeveloperAccess } from '../../common/devAccess';
import { AppError } from '../../common/AppError';
import { publishedCache } from '../../core/publishedCache';
import { GlobalUIPackage } from '@idp/shared';
import { UIPackage } from '@idp/shared';
import { resolveGlobalDataSource } from '../../core/globalDatasource';
import { resolveGlobalPackage } from '../registry/globalPackages';
import { TenantRequest } from '../../types/RequestContext';

export class RegistryController {
  constructor(private readonly dataSource: DataSource) {}

  resolveTenantOnly = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const { name, version } = req.params;
      if (!name) {
        return res.status(400).json({ error: 'Package name required' });
      }
      if (!req.tenant) {
        return res.status(404).json({ error: 'Package not found' });
      }

      const versionToken = version || 'latest';
      const isDev = isDeveloperAccess(req);
      const pkgRepo = this.dataSource.getRepository(UIPackage);

      const findPackage = async (tenantId: string) => {
        if (!version || version === 'latest') {
          const latest = await pkgRepo.find({
            where: { tenant: { id: tenantId }, name },
            relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
            order: { createdAt: 'DESC' },
            take: 1,
          });
          return latest[0] ?? null;
        }
        return pkgRepo.findOne({
          where: { tenant: { id: tenantId }, name, version },
          relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
        });
      };

      if (!isDev) {
        const tenantCacheKey = this.registryCacheKey('tenant', req.tenant.id, name, versionToken);
        const cached = await publishedCache.get(tenantCacheKey);
        if (cached) {
          return res.json(cached);
        }
      }

      const pkg = await findPackage(req.tenant.id);

      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      if (isDev) {
        return res.json(this.serializeDraft(pkg));
      }

      if (!this.hasPublished(pkg)) {
        return res.status(404).json({ error: 'Package not published' });
      }

      const payload = this.serializePublished(pkg);
      await publishedCache.set(
        this.registryCacheKey('tenant', req.tenant.id, name, versionToken),
        payload
      );
      return res.json(payload);
    } catch (error) {
      next(error);
    }
  };

  resolve = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const { name, version } = req.params;
      if (!name) {
        return res.status(400).json({ error: 'Package name required' });
      }
      const versionToken = version || 'latest';
      const isDev = isDeveloperAccess(req);

      const globalDataSource = await resolveGlobalDataSource(this.dataSource);
      const globalRepo = globalDataSource.getRepository(GlobalUIPackage);
      const pkgRepo = this.dataSource.getRepository(UIPackage);

      const findGlobalPackage = async () => {
        if (!version || version === 'latest') {
          const latest = await globalRepo.find({
            where: { name },
            relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
            order: { createdAt: 'DESC' },
            take: 1,
          });
          return latest[0] ?? null;
        }
        return globalRepo.findOne({
          where: { name, version },
          relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
        });
      };

      const findPackage = async (tenantId: string) => {
        if (!version || version === 'latest') {
          const latest = await pkgRepo.find({
            where: { tenant: { id: tenantId }, name },
            relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
            order: { createdAt: 'DESC' },
            take: 1,
          });
          return latest[0] ?? null;
        }
        return pkgRepo.findOne({
          where: { tenant: { id: tenantId }, name, version },
          relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
        });
      };

      if (!isDev) {
        const globalCacheKey = this.registryCacheKey('global', undefined, name, versionToken);
        const cached = await publishedCache.get(globalCacheKey);
        if (cached) {
          return res.json(cached);
        }
      }

      const globalPkg = await findGlobalPackage();
      if (globalPkg) {
        if (isDev) {
          return res.json(this.serializeDraft(globalPkg));
        }
        if (this.hasPublished(globalPkg)) {
          const payload = this.serializePublished(globalPkg);
          await publishedCache.set(this.registryCacheKey('global', undefined, name, versionToken), payload);
          return res.json(payload);
        }
      }

      const builtinPackage = resolveGlobalPackage(name, version);
      if (builtinPackage) {
        return res.json({
          name: builtinPackage.name,
          version: builtinPackage.version,
          source: builtinPackage.source,
          dependencies: builtinPackage.dependencies ?? [],
          fileExtension: builtinPackage.fileExtension,
        });
      }

      if (!req.tenant) {
        return res.status(404).json({ error: 'Package not found' });
      }

      if (!isDev) {
        const tenantCacheKey = this.registryCacheKey('tenant', req.tenant.id, name, versionToken);
        const cached = await publishedCache.get(tenantCacheKey);
        if (cached) {
          return res.json(cached);
        }
      }

      const pkg = await findPackage(req.tenant.id);

      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      if (isDev) {
        return res.json(this.serializeDraft(pkg));
      }

      if (!this.hasPublished(pkg)) {
        return res.status(404).json({ error: 'Package not published' });
      }

      const payload = this.serializePublished(pkg);
      await publishedCache.set(
        this.registryCacheKey('tenant', req.tenant.id, name, versionToken),
        payload
      );
      return res.json(payload);
    } catch (error) {
      next(error);
    }
  };

  private hasPublished(pkg: UIPackage | GlobalUIPackage) {
    return Boolean(pkg.publishedCompiledCode?.code) && Boolean(pkg.publishedVersion);
  }

  private registryCacheKey(
    scope: 'tenant' | 'global',
    tenantId: string | undefined,
    name: string,
    version: string
  ) {
    const encoded = encodeURIComponent(name);
    if (scope === 'tenant' && tenantId) {
      return `registry:tenant:${tenantId}:${encoded}:${version}`;
    }
    return `registry:global:${encoded}:${version}`;
  }

  private serializeDraft(pkg: UIPackage | GlobalUIPackage) {
    return {
      name: pkg.name,
      version: pkg.draftVersion || pkg.version,
      packageVersion: pkg.version,
      source: this.requireCompiledCode(pkg),
      dependencies: pkg.dependencies ?? [],
      fileExtension: pkg.fileExtension,
    };
  }

  private serializePublished(pkg: UIPackage | GlobalUIPackage) {
    return {
      name: pkg.name,
      version: pkg.publishedVersion || pkg.version,
      packageVersion: pkg.version,
      source: this.requirePublishedCompiledCode(pkg),
      dependencies: pkg.publishedDependencies ?? [],
      fileExtension: pkg.publishedFileExtension ?? pkg.fileExtension,
    };
  }

  private requireCompiledCode(pkg: UIPackage | GlobalUIPackage) {
    if (!pkg.compiledCode?.code) {
      throw new AppError(`Package ${pkg.name}@${pkg.version} is missing compiled code`, 500);
    }
    return pkg.compiledCode.code;
  }

  private requirePublishedCompiledCode(pkg: UIPackage | GlobalUIPackage) {
    if (!pkg.publishedCompiledCode?.code) {
      throw new AppError(`Package ${pkg.name}@${pkg.version} is missing published code`, 500);
    }
    return pkg.publishedCompiledCode.code;
  }
}
