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
import { TenantRequest } from '../../types/RequestContext';
import { transformSync } from 'esbuild';

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
      const requestedName = this.normalizeRequestedName(req.params?.name as string | undefined);
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
        const lookupNames = this.buildTenantLookupNames(requestedName);
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
        const tenantCacheKey = this.registryCacheKey('tenant', req.tenant.id, requestedName, versionToken);
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
        this.registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
        payload
      );
      return res.json(this.formatRegistryResponse(payload, metadataOnly));
    } catch (error) {
      next(error);
    }
  };

  resolve = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const requestedName = this.normalizeRequestedName(req.params?.name as string | undefined);
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
        const lookupNames = this.buildGlobalLookupNames(requestedName);
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
        const lookupNames = this.buildTenantLookupNames(requestedName);
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
        const globalCacheKey = this.registryCacheKey('global', undefined, requestedName, versionToken);
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
            this.registryCacheKey('global', undefined, requestedName, versionToken),
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
          const tenantCacheKey = this.registryCacheKey(
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
              this.registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
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
              this.registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
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
            this.registryCacheKey('tenant', req.tenant.id, requestedName, versionToken),
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
      aliases: this.buildCatalogAliases(pkg.name, scope),
      scope,
    };
  }

  private buildCatalogAliases(name: string, scope: 'tenant' | 'global') {
    const aliases = scope === 'global'
      ? this.buildGlobalLookupNames(name)
      : this.buildTenantLookupNames(name);
    return Array.from(new Set([name, ...aliases]));
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

  private normalizeRequestedName(raw: string | undefined) {
    if (!raw) return '';
    let normalized = String(raw).trim();
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(normalized);
        if (decoded === normalized) break;
        normalized = decoded.trim();
      } catch {
        break;
      }
    }
    normalized = normalized.replace(/\\/g, '/');
    normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized;
  }

  private buildGlobalLookupNames(name: string) {
    const base = this.normalizeRequestedName(name);
    const values = new Set<string>();
    if (!base) return [] as string[];
    values.add(base);
    if (base.startsWith('@shared/')) {
      values.add(base.slice('@shared/'.length));
    } else if (!base.startsWith('@')) {
      values.add(`@shared/${base}`);
    }
    return Array.from(values);
  }

  private buildTenantLookupNames(name: string) {
    const base = this.normalizeRequestedName(name);
    const values = new Set<string>();
    if (!base) return [] as string[];
    values.add(base);
    if (base.startsWith('@shared/')) {
      values.add(base.slice('@shared/'.length));
    }
    return Array.from(values);
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
    const source = this.resolveDraftRuntimeSource(pkg, compiled, preferSource);
    return {
      name: pkg.name,
      version: pkg.draftVersion || pkg.version,
      packageVersion: pkg.version,
      source,
      dependencies: pkg.dependencies ?? [],
      fileExtension: pkg.fileExtension,
    };
  }

  private resolveDraftRuntimeSource(
    pkg: UIPackage | GlobalUIPackage,
    compiled: string,
    preferSource: boolean
  ) {
    if (!preferSource) {
      return this.repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
    }

    const sourceCode = pkg.sourceCode?.code;
    if (!sourceCode || typeof sourceCode !== 'string' || !sourceCode.trim()) {
      return this.repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
    }

    const ext = String(pkg.fileExtension || '').trim().toLowerCase();
    if (ext === 'css' || ext === 'json') {
      return sourceCode;
    }

    const loader = ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx' ? ext : 'jsx';
    const sourcefile =
      pkg.name && String(pkg.name).includes('.')
        ? String(pkg.name)
        : `${pkg.name}.${loader}`;
    try {
      const transformed = transformSync(sourceCode, {
        loader: loader as 'js' | 'jsx' | 'ts' | 'tsx',
        format: 'cjs',
        target: 'es2019',
        sourcemap: 'inline',
        sourcefile,
        jsx: 'transform',
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
      });
      const code = String(transformed.code || '').trim();
      if (!code) {
        return this.repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
      }
      return this.repairUiCompiledSource(pkg.name, code, pkg.fileExtension);
    } catch {
      return this.repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
    }
  }

  private serializePublished(pkg: UIPackage | GlobalUIPackage) {
    const publishedCompiled = this.requirePublishedCompiledCode(pkg);
    const ext = pkg.publishedFileExtension ?? pkg.fileExtension;
    return {
      name: pkg.name,
      version: pkg.publishedVersion || pkg.version,
      packageVersion: pkg.version,
      cacheKey: this.resolvePackageCacheKey(pkg),
      source: this.repairUiCompiledSource(pkg.name, publishedCompiled, ext),
      dependencies: pkg.publishedDependencies ?? [],
      fileExtension: ext,
    };
  }

  private repairUiCompiledSource(name: string, source: string, fileExtension?: string | null) {
    const ext = String(fileExtension || '').trim().toLowerCase();
    if (ext !== 'js' && ext !== 'jsx') return source;
    if (!source || typeof source !== 'string') return source;
    const materialized = this.materializeVirtualPackageSource(source, ext) || source;
    if (
      name.startsWith('@idp/') ||
      name.startsWith('idp/')
    )
      return materialized;

    const hasAnyExports =
      materialized.includes('exports.') ||
      materialized.includes('module.exports') ||
      materialized.includes('Object.defineProperty(exports');
    if (hasAnyExports) return materialized;

    const pkgTail = name.split('/').pop() || name;
    const inferred = pkgTail
      .split(/[^a-zA-Z0-9]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    if (!inferred) return materialized;

    const declared =
      new RegExp(`\\bfunction\\s+${inferred}\\b`).test(materialized) ||
      new RegExp(`\\b(?:var|let|const|class)\\s+${inferred}\\b`).test(materialized);
    if (!declared) return materialized;

    const patch = `
;try {
  if (typeof ${inferred} !== 'undefined') {
    if (typeof exports === 'object' && exports) {
      if (typeof exports.default === 'undefined') exports.default = ${inferred};
      if (typeof exports.${inferred} === 'undefined') exports.${inferred} = ${inferred};
    }
  }
} catch (e) {}
`;
    return `${materialized}\n${patch}`;
  }

  private materializeVirtualPackageSource(source: string, fileExtension?: string | null) {
    const raw = String(source || '').trim();
    if (!raw || raw[0] !== '{') return null;
    try {
      const parsed = JSON.parse(raw) as {
        entryPath?: unknown;
        files?: Array<{
          path?: unknown;
          fileExtension?: unknown;
          content?: unknown;
        }>;
      };
      if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) return null;

      const normalizePath = (value: string) =>
        value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
      const pickLoader = (pathValue: string, extHint?: string | null) => {
        const fromPath = pathValue.includes('.') ? pathValue.split('.').pop() || '' : '';
        const ext = String(fromPath || extHint || '')
          .trim()
          .toLowerCase();
        if (ext === 'ts') return 'ts' as const;
        if (ext === 'tsx') return 'tsx' as const;
        if (ext === 'js') return 'js' as const;
        if (ext === 'jsx') return 'jsx' as const;
        return 'jsx' as const;
      };

      const entries = parsed.files
        .map((file) => {
          const pathValue = typeof file?.path === 'string' ? normalizePath(file.path) : '';
          const content = typeof file?.content === 'string' ? file.content : '';
          if (!pathValue || !content) return null;
          const loader = pickLoader(
            pathValue,
            typeof file?.fileExtension === 'string' ? file.fileExtension : fileExtension
          );
          return { path: pathValue, content, loader };
        })
        .filter(Boolean) as Array<{ path: string; content: string; loader: 'ts' | 'tsx' | 'js' | 'jsx' }>;
      if (entries.length === 0) return null;

      const entryHint =
        typeof parsed.entryPath === 'string' && parsed.entryPath.trim()
          ? normalizePath(parsed.entryPath)
          : '';
      const preferred = [
        entryHint,
        'src/index.tsx',
        'src/index.ts',
        'src/index.jsx',
        'src/index.js',
        'index.tsx',
        'index.ts',
        'index.jsx',
        'index.js',
      ].filter(Boolean);
      let entry = entries[0];
      for (const candidate of preferred) {
        const found = entries.find((item) => item.path === candidate);
        if (found) {
          entry = found;
          break;
        }
      }

      const transformed = transformSync(entry.content, {
        loader: entry.loader,
        format: 'cjs',
        target: 'es2019',
        sourcemap: false,
        jsx: 'transform',
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
      });
      const code = String(transformed.code || '').trim();
      return code || null;
    } catch {
      return null;
    }
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
