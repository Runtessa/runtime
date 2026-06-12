import { NextFunction, Response } from 'express';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { isDeveloperAccess } from '../../common/devAccess';
import { AppError } from '../../common/AppError';
import { publishedCache } from '../../core/publishedCache';
import { GlobalUIPackage, GlobalModulePackage } from '@idp/shared';
import { UIPackage } from '@idp/shared';
import { TenantNpmPackageBuild } from '@idp/shared';
import { resolveGlobalDataSource } from '../../core/globalDatasource';
import { resolveGlobalPackage } from '../registry/globalPackages';
import { resolveNpmRegistryPackage } from '../registry/npmPackageResolver';
import {
  buildCatalogAliases,
  buildGlobalLookupNames,
  buildTenantLookupNames,
  normalizeRequestedName,
  registryCacheKey,
} from '../registry/registryNaming';
import {
  repairUiCompiledSource,
  resolveDraftRuntimeSource,
} from '../registry/registrySource';
import { TenantRequest } from '../../types/RequestContext';

export class RegistryController {
  constructor(private readonly dataSource: DataSource) {}

  catalogTenantOnly = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }
      return res.json(await this.buildCatalog(req, true));
    } catch (error) {
      next(error);
    }
  };

  catalog = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      return res.json(await this.buildCatalog(req, false));
    } catch (error) {
      next(error);
    }
  };

  resolveTenantOnly = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const requestedName = normalizeRequestedName(req.params?.name as string | undefined);
      const version = req.params?.version;
      const metadataOnly = this.isMetadataOnly(req);
      if (!requestedName) {
        return res.status(400).json({ error: 'Package name required' });
      }
      if (!req.tenant) {
        return res.status(404).json({ error: 'Package not found' });
      }

      const versionToken = version || 'latest';
      const isDev = isDeveloperAccess(req);
      const preferDraftSource = this.shouldPreferDraftSource(req);
      const pkgRepo = this.dataSource.getRepository(UIPackage);

      const findPackage = async (tenantId: string) => {
        const lookupNames = buildTenantLookupNames(requestedName);
        if (!lookupNames.includes(requestedName)) {
          lookupNames.unshift(requestedName);
        }
        if (!version || version === 'latest') {
          const latest = await pkgRepo.find({
            where: { tenant: { id: tenantId }, name: In(lookupNames) },
            relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
            order: { createdAt: 'DESC' },
            take: 1,
          });
          return latest[0] ?? null;
        }
        return pkgRepo.findOne({
          where: { tenant: { id: tenantId }, name: In(lookupNames), version },
          relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
        });
      };

      if (!isDev) {
        const tenantCacheKey = registryCacheKey('tenant', req.tenant.id, requestedName, versionToken);
        const cached = await publishedCache.get<{
          name: string;
          version: string;
          packageVersion?: string;
          dependencies?: string[];
          fileExtension?: string;
          source?: string;
        }>(tenantCacheKey);
        if (cached) {
          return res.json(this.formatRegistryResponse(cached, metadataOnly));
        }
      }

      const pkg = await findPackage(req.tenant.id);

      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }

      if (isDev) {
        return res.json(
          this.formatRegistryResponse(
            this.serializeDraft(pkg, preferDraftSource),
            metadataOnly
          )
        );
      }

      if (!this.hasPublished(pkg)) {
        return res.status(404).json({ error: 'Package not published' });
      }

      const payload = this.serializePublished(pkg);
      await publishedCache.set(
        registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
        payload
      );
      return res.json(this.formatRegistryResponse(payload, metadataOnly));
    } catch (error) {
      next(error);
    }
  };

  resolve = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const requestedName = normalizeRequestedName(req.params?.name as string | undefined);
      const version = req.params?.version;
      const metadataOnly = this.isMetadataOnly(req);
      if (!requestedName) {
        return res.status(400).json({ error: 'Package name required' });
      }
      const versionToken = version || 'latest';
      const isDev = isDeveloperAccess(req);
      const preferDraftSource = this.shouldPreferDraftSource(req);

      const globalDataSource = await resolveGlobalDataSource(this.dataSource);
      const globalRepo = globalDataSource.getRepository(GlobalUIPackage);
      const globalModuleRepo = globalDataSource.getRepository(GlobalModulePackage);
      const pkgRepo = this.dataSource.getRepository(UIPackage);
      const tenantNpmBuildRepo = this.dataSource.getRepository(TenantNpmPackageBuild);

      const findGlobalPackage = async () => {
        const lookupNames = buildGlobalLookupNames(requestedName);
        if (!lookupNames.includes(requestedName)) {
          lookupNames.unshift(requestedName);
        }

        const findInRepo = async (repo: any) => {
          if (!version || version === 'latest') {
            const latest = await repo.find({
              where: { name: In(lookupNames) },
              relations: [
                'sourceCode',
                'compiledCode',
                'publishedSourceCode',
                'publishedCompiledCode',
              ],
              order: { createdAt: 'DESC' },
              take: 1,
            });
            return latest[0] ?? null;
          }
          return repo.findOne({
            where: { name: In(lookupNames), version },
            relations: [
              'sourceCode',
              'compiledCode',
              'publishedSourceCode',
              'publishedCompiledCode',
            ],
          });
        };

        const pkg = await findInRepo(globalRepo);
        if (pkg) return pkg;
        return findInRepo(globalModuleRepo);
      };

      const findPackage = async (tenantId: string) => {
        const lookupNames = buildTenantLookupNames(requestedName);
        if (!lookupNames.includes(requestedName)) {
          lookupNames.unshift(requestedName);
        }
        if (!version || version === 'latest') {
          const latest = await pkgRepo.find({
            where: { tenant: { id: tenantId }, name: In(lookupNames) },
            relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
            order: { createdAt: 'DESC' },
            take: 1,
          });
          return latest[0] ?? null;
        }
        return pkgRepo.findOne({
          where: { tenant: { id: tenantId }, name: In(lookupNames), version },
          relations: ['sourceCode', 'compiledCode', 'publishedSourceCode', 'publishedCompiledCode'],
        });
      };

      const findTenantNpmBuild = async (tenantId: string) => {
        if (!version || version === 'latest') {
          return tenantNpmBuildRepo.findOne({
            where: {
              tenant: { id: tenantId },
              specifier: requestedName,
              requestedVersion: 'latest',
            },
            relations: ['compiledCode', 'sourceCode'],
            order: { createdAt: 'DESC' },
          });
        }
        const exact = await tenantNpmBuildRepo.findOne({
            where: {
              tenant: { id: tenantId },
              specifier: requestedName,
              resolvedVersion: version,
            },
            relations: ['compiledCode', 'sourceCode'],
          order: { createdAt: 'DESC' },
        });
        if (exact) return exact;
        return tenantNpmBuildRepo.findOne({
            where: {
              tenant: { id: tenantId },
              specifier: requestedName,
              requestedVersion: version,
            },
            relations: ['compiledCode', 'sourceCode'],
          order: { createdAt: 'DESC' },
        });
      };

      if (!isDev) {
        const globalCacheKey = registryCacheKey('global', undefined, requestedName, versionToken);
        const cached = await publishedCache.get<{
          name: string;
          version: string;
          packageVersion?: string;
          dependencies?: string[];
          fileExtension?: string;
          source?: string;
        }>(globalCacheKey);
        if (cached) {
          return res.json(this.formatRegistryResponse(cached, metadataOnly));
        }
      }

      const globalPkg = await findGlobalPackage();
      if (globalPkg) {
        if (isDev) {
          return res.json(
            this.formatRegistryResponse(
              {
                ...this.serializeDraft(globalPkg, preferDraftSource),
                name: requestedName, // Use requested name
              },
              metadataOnly
            )
          );
        }
        if (this.hasPublished(globalPkg)) {
          const payload = {
            ...this.serializePublished(globalPkg),
            cacheKey: this.resolvePackageCacheKey(globalPkg),
            name: requestedName, // Use requested name
          };
          await publishedCache.set(
            registryCacheKey('global', undefined, requestedName, versionToken),
            payload
          );
          return res.json(this.formatRegistryResponse(payload, metadataOnly));
        }
      }

      const builtinPackage = resolveGlobalPackage(requestedName, version);
      if (builtinPackage) {
        return res.json(this.formatRegistryResponse({
          name: builtinPackage.name,
          version: builtinPackage.version,
          source: builtinPackage.source,
          dependencies: builtinPackage.dependencies ?? [],
          fileExtension: builtinPackage.fileExtension,
        }, metadataOnly));
      }

      if (req.tenant) {
        if (!isDev) {
          const tenantCacheKey = registryCacheKey(
            'tenant',
            req.tenant.id,
            requestedName,
            versionToken
          );
          const cached = await publishedCache.get<{
            name: string;
            version: string;
            packageVersion?: string;
            dependencies?: string[];
            fileExtension?: string;
            source?: string;
          }>(tenantCacheKey);
          if (cached) {
            return res.json(this.formatRegistryResponse(cached, metadataOnly));
          }
        }

        const pkg = await findPackage(req.tenant.id);
        if (pkg) {
          if (isDev) {
            return res.json(
              this.formatRegistryResponse(
                {
                  ...this.serializeDraft(pkg, preferDraftSource),
                  name: requestedName, // Use requested name
                },
                metadataOnly
              )
            );
          }
          if (this.hasPublished(pkg)) {
            const payload = {
              ...this.serializePublished(pkg),
              cacheKey: this.resolvePackageCacheKey(pkg),
              name: requestedName, // Use requested name
            };
            await publishedCache.set(
              registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
              payload
            );
            return res.json(this.formatRegistryResponse(payload, metadataOnly));
          }
          return res.status(404).json({ error: 'Package not published' });
        }

        const npmBuild = await findTenantNpmBuild(req.tenant.id);
        if (npmBuild?.compiledCode?.code) {
          let shouldSkipCachedBuild = false;
          if (npmBuild.specifier === 'react-router/dom') {
            let runtimeSpecifier = '';
            try {
              const metadata = npmBuild.sourceCode?.code
                ? JSON.parse(npmBuild.sourceCode.code)
                : null;
              if (metadata && typeof metadata.runtimeSpecifier === 'string') {
                runtimeSpecifier = metadata.runtimeSpecifier.trim();
              }
            } catch {
              runtimeSpecifier = '';
            }
            shouldSkipCachedBuild = runtimeSpecifier !== 'react-router-dom';
          }
          if (shouldSkipCachedBuild) {
            // Skip stale cached artifacts and rebuild through npm resolver.
          } else {
          const payload = {
            name: npmBuild.specifier,
            version: npmBuild.resolvedVersion,
            cacheKey: this.resolveNpmBuildCacheKey(npmBuild),
            source: npmBuild.compiledCode.code,
            dependencies: npmBuild.dependencies ?? [],
            fileExtension: 'js',
          };
          if (!isDev) {
            await publishedCache.set(
              registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
              payload
            );
          }
          return res.json(this.formatRegistryResponse(payload, metadataOnly));
          }
        }
      }

      const npmPayload = await resolveNpmRegistryPackage(requestedName, version);
      if (npmPayload) {
        if (!isDev && req.tenant) {
          await publishedCache.set(
            registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
            npmPayload
          );
        }
        return res.json(this.formatRegistryResponse(npmPayload, metadataOnly));
      }

      return res.status(404).json({ error: 'Package not found' });
    } catch (error) {
      next(error);
    }
  };

  private hasPublished(pkg: UIPackage | GlobalUIPackage) {
    return Boolean(pkg.publishedCompiledCode?.code) && Boolean(pkg.publishedVersion);
  }

  private async buildCatalog(req: TenantRequest, tenantOnly: boolean) {
    const packages: Array<{
      name: string;
      version: string;
      packageVersion?: string;
      cacheKey?: string;
      dependencies?: string[];
      fileExtension?: string;
      aliases?: string[];
      scope: 'tenant' | 'global' | 'npm';
    }> = [];

    if (!tenantOnly) {
      const globalDataSource = await resolveGlobalDataSource(this.dataSource);
      const globalRepo = globalDataSource.getRepository(GlobalUIPackage);
      const globalModuleRepo = globalDataSource.getRepository(GlobalModulePackage);
      const globalPackages = await globalRepo.find({
        where: { publishedVersion: Not(IsNull()) },
        order: { createdAt: 'DESC' },
      });
      const globalModules = await globalModuleRepo.find({
        where: { publishedVersion: Not(IsNull()) },
        order: { createdAt: 'DESC' },
      });

      for (const pkg of [...globalPackages, ...globalModules]) {
        packages.push(this.serializeCatalogEntry(pkg, 'global'));
      }
    }

    if (req.tenant) {
      const pkgRepo = this.dataSource.getRepository(UIPackage);
      const tenantPackages = await pkgRepo.find({
        where: { tenant: { id: req.tenant.id }, publishedVersion: Not(IsNull()) },
        order: { createdAt: 'DESC' },
      });
      for (const pkg of tenantPackages) {
        packages.push(this.serializeCatalogEntry(pkg, 'tenant'));
      }

      if (!tenantOnly) {
        const npmBuildRepo = this.dataSource.getRepository(TenantNpmPackageBuild);
        const npmBuilds = await npmBuildRepo.find({
          where: { tenant: { id: req.tenant.id } },
          order: { updatedAt: 'DESC' },
        });
        for (const build of npmBuilds) {
          packages.push({
            name: build.specifier,
            version: build.resolvedVersion,
            packageVersion: build.requestedVersion,
            cacheKey: this.resolveNpmBuildCacheKey(build),
            dependencies: build.dependencies ?? [],
            fileExtension: 'js',
            aliases: Array.from(
              new Set([build.specifier, build.installName].filter(Boolean))
            ),
            scope: 'npm',
          });
        }
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      tenantHost: req.tenant?.hostname ?? null,
      packages,
    };
  }

  private serializeCatalogEntry(
    pkg: UIPackage | GlobalUIPackage | GlobalModulePackage,
    scope: 'tenant' | 'global'
  ) {
    return {
      name: pkg.name,
      version: pkg.publishedVersion || pkg.version,
      packageVersion: pkg.version,
      cacheKey: this.resolvePackageCacheKey(pkg),
      dependencies: pkg.publishedDependencies ?? [],
      fileExtension: pkg.publishedFileExtension ?? pkg.fileExtension,
      aliases: buildCatalogAliases(pkg.name, scope),
      scope,
    };
  }


  private resolvePackageCacheKey(pkg: UIPackage | GlobalUIPackage | GlobalModulePackage) {
    const version = pkg.publishedVersion || pkg.version;
    const publishedAt = this.dateToCachePart(pkg.publishedAt);
    const updatedAt = this.dateToCachePart(pkg.updatedAt);
    return `${pkg.name}@${version}:${publishedAt || updatedAt}`;
  }

  private resolveNpmBuildCacheKey(pkg: TenantNpmPackageBuild) {
    return `npm:${pkg.specifier}@${pkg.resolvedVersion}:${this.dateToCachePart(pkg.updatedAt)}`;
  }

  private dateToCachePart(value?: Date | string | null) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }


  private shouldPreferDraftSource(req: TenantRequest) {
    const raw = req.headers['x-dev-source'];
    if (raw === undefined) return false;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  private isMetadataOnly(req: TenantRequest) {
    const raw = req.query?.meta;
    if (raw === undefined) return false;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  private formatRegistryResponse<
    T extends {
      name: string;
      version: string;
      packageVersion?: string;
      cacheKey?: string;
      dependencies?: string[];
      fileExtension?: string;
      source?: string;
    },
  >(payload: T, metadataOnly: boolean) {
    if (!metadataOnly) return payload;
    return {
      name: payload.name,
      version: payload.version,
      packageVersion: payload.packageVersion,
      cacheKey: payload.cacheKey,
      dependencies: payload.dependencies ?? [],
      fileExtension: payload.fileExtension,
    };
  }

  private serializeDraft(pkg: UIPackage | GlobalUIPackage, preferSource = false) {
    const compiled = this.requireCompiledCode(pkg);
    const source = resolveDraftRuntimeSource(pkg, compiled, preferSource);
    return {
      name: pkg.name,
      version: pkg.draftVersion || pkg.version,
      packageVersion: pkg.version,
      source,
      dependencies: pkg.dependencies ?? [],
      fileExtension: pkg.fileExtension,
    };
  }


  private serializePublished(pkg: UIPackage | GlobalUIPackage) {
    const publishedCompiled = this.requirePublishedCompiledCode(pkg);
    const ext = pkg.publishedFileExtension ?? pkg.fileExtension;
    return {
      name: pkg.name,
      version: pkg.publishedVersion || pkg.version,
      packageVersion: pkg.version,
      cacheKey: this.resolvePackageCacheKey(pkg),
      source: repairUiCompiledSource(pkg.name, publishedCompiled, ext),
      dependencies: pkg.publishedDependencies ?? [],
      fileExtension: ext,
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
