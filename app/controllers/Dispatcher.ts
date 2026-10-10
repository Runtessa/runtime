import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { isDeveloperAccess } from '../../common/devAccess';
import { publishedCache } from '../../core/publishedCache';
import { AdapterFactory } from '../../engine/AdapterFactory';
import { SandboxRunner, SandboxRequestContext } from '../../engine/SandboxRunner';
import { GlobalModuleEndpoint, GlobalModulePackage, HttpMethod, ModuleEntity, Tenant } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';
import { resolveGlobalDataSource } from '../../core/globalDatasource';
import { findMatchingModule, matchPath, publishedModulesCacheKey } from './dispatcherPath';

type ModuleLike = {
  routePath: string;
  method: HttpMethod;
  code: string;
  fileExtension?: string;
};

type SharedEndpointMatch = {
  routePath: string;
  method: HttpMethod;
  packageName: string;
  packageVersion: string;
};

export class Dispatcher {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adapterFactory: AdapterFactory,
    private readonly sandboxRunner: SandboxRunner,
  ) {}

  handle = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError('Tenant required', 400);
      }

      const normalizedMethod = req.method.toUpperCase();
      if (!Object.values(HttpMethod).includes(normalizedMethod as HttpMethod)) {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const moduleRepo = this.dataSource.getRepository(ModuleEntity);
      const isDev = isDeveloperAccess(req);
      let modules: ModuleLike[] = [];

      if (isDev) {
        const dbModules = await moduleRepo.find({
          where: { tenant: { id: req.tenant.id }, method: normalizedMethod as HttpMethod },
          relations: ['sourceCode'],
          order: { routePath: 'ASC' },
        });
        modules = dbModules.map((mod) => ({
          routePath: mod.routePath,
          method: mod.method,
          code: this.requireModuleSourceCode(mod),
          fileExtension: mod.fileExtension,
        }));
      } else {
        const cacheKey = publishedModulesCacheKey(req.tenant.id, normalizedMethod as HttpMethod);
        const cached = await publishedCache.get<ModuleLike[]>(cacheKey);
        if (cached) {
          modules = cached;
        } else {
          const published = await moduleRepo.find({
            where: { tenant: { id: req.tenant.id } },
            relations: ['publishedSourceCode'],
            order: { publishedRoutePath: 'ASC', routePath: 'ASC' },
          });
          modules = published
            .filter(
              (mod) =>
                Boolean(mod.publishedSourceCode) &&
                Boolean(mod.publishedVersion) &&
                (mod.publishedMethod ?? mod.method) === (normalizedMethod as HttpMethod)
            )
            .map((mod) => ({
              routePath: mod.publishedRoutePath ?? mod.routePath,
              method: (mod.publishedMethod ?? mod.method) as HttpMethod,
              code: mod.publishedSourceCode!.code,
              fileExtension: mod.publishedFileExtension ?? mod.fileExtension,
            }));
          await publishedCache.set(cacheKey, modules);
        }
      }

      const matchResult = findMatchingModule(modules, req.path);
      const sharedMatch = matchResult
        ? null
        : await this.findMatchingSharedEndpoint(normalizedMethod as HttpMethod, req.path, isDev);
      if (!matchResult && !sharedMatch) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const module = matchResult
        ? matchResult.module
        : ({
            routePath: sharedMatch!.routePath,
            method: sharedMatch!.method,
            code: '',
          } as ModuleLike);
      const params =
        matchResult?.params ?? matchPath(module.routePath, req.path) ?? {};

      let endpointConfig = this.resolveEndpointConfig(
        req.tenant as Tenant,
        module.routePath,
        req.path
      );
      if (!endpointConfig) {
        endpointConfig = await this.ensureEndpointConfig(
          req.tenant as Tenant,
          module.routePath
        );
      }
      const allowAnonymous = Boolean((endpointConfig as any)?.allowAnonymous);
      if (!req.account && !allowAnonymous) {
        throw new AppError('Authentication required', 401);
      }

      if (!allowAnonymous) {
        const aclAllowed = this.checkEndpointAccess(
          req.tenant as Tenant,
          req.account?.role ?? '',
          module,
          req.account?.groups ?? [],
          req.path,
        );
        if (!aclAllowed) {
          throw new AppError('Access denied', 403);
        }
      }

      const adapters = await this.adapterFactory.build(req.tenant, {
        allowDraftSharedModules: isDev,
      });
      const requestContext: SandboxRequestContext = {
        path: req.path,
        method: normalizedMethod,
        headers: this.normalizeHeaders(req.headers),
        query: { ...(req.query as Record<string, unknown>) },
        body: req.body,
        params,
        tenant: {
          id: req.tenant.id,
          hostname: req.tenant.hostname,
          resourceConfig: req.tenant.resourceConfig ?? { memory: 512, timeout: 5_000 },
        },
        account: req.account
          ? { id: req.account.id, email: req.account.email, role: req.account.role }
          : undefined,
      };

      const code = sharedMatch ? `module.exports = async (request, adapters) => {
        const exported = await adapters.shared.require(${JSON.stringify(sharedMatch.packageName)}, ${JSON.stringify(sharedMatch.packageVersion)});
        const handler = typeof exported === 'function' ? exported : exported && exported.default;
        if (typeof handler !== 'function') throw Object.assign(new Error('Shared module must export a function'), {statusCode: 400});
        return handler(request, adapters);
      };` : module.code;
      const sandboxResult = await this.sandboxRunner.run(code, {
        request: requestContext, adapters, tenant: req.tenant as Tenant,
        allowDraftSharedModules: isDev,
        capabilities: this.adapterFactory.runtimeCapabilities(req.tenant as Tenant, isDev),
      });

      res.status(sandboxResult.statusCode ?? 200);
      if (sandboxResult.headers) {
        for (const [key, value] of Object.entries(sandboxResult.headers)) {
          res.setHeader(key, value);
        }
      }
      res.send(sandboxResult.body ?? null);
    } catch (error) {
      next(error);
    }
  };

  private normalizeHeaders(headers: TenantRequest['headers']): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!value) {
        continue;
      }

      if (Array.isArray(value)) {
        normalized[key] = value.join(',');
      } else {
        normalized[key] = String(value);
      }
    }
    return normalized;
  }

  private requireModuleSourceCode(mod: ModuleEntity) {
    if (!mod.sourceCode?.code) {
      throw new AppError(`Module ${mod.id} is missing source code`, 500);
    }
    return mod.sourceCode.code;
  }

  private async findMatchingSharedEndpoint(
    method: HttpMethod,
    path: string,
    allowDraft: boolean,
  ): Promise<SharedEndpointMatch | null> {
    const globalDataSource = await resolveGlobalDataSource(this.dataSource);
    const repo = globalDataSource.getRepository(GlobalModuleEndpoint);
    const endpoints = await repo.find({
      where: { method },
      relations: ['package', 'package.compiledCode', 'package.publishedCompiledCode'],
      order: { routePath: 'ASC' },
    });

    for (const endpoint of endpoints) {
      const pkg = endpoint.package as GlobalModulePackage | undefined;
      if (!pkg) continue;
      const match = matchPath(endpoint.routePath, path);
      if (!match) continue;
      if (!allowDraft) {
        if (!pkg.publishedCompiledCode?.code || !pkg.publishedVersion) {
          return null;
        }
      }
      return {
        routePath: endpoint.routePath,
        method: endpoint.method as HttpMethod,
        packageName: pkg.name,
        packageVersion: pkg.version,
      };
    }

    return null;
  }

  private resolveEndpointConfig(
    tenant: Tenant,
    routePath: string,
    requestPath?: string,
  ) {
    const endpoints = (tenant.aclEndpoints || {}) as Record<
      string,
      {
        read?: string[];
        write?: string[];
        edit?: string[];
        delete?: string[];
        allowAnonymous?: boolean;
      }
    >;
    if (endpoints[routePath]) return endpoints[routePath];
    if (!requestPath) return undefined;
    if (endpoints[requestPath]) return endpoints[requestPath];
    if (requestPath.length > 1 && requestPath.endsWith('/')) {
      const trimmed = requestPath.replace(/\/+$/, '');
      if (endpoints[trimmed]) return endpoints[trimmed];
    }
    return undefined;
  }

  private async ensureEndpointConfig(tenant: Tenant, routePath: string) {
    const endpoints = (tenant.aclEndpoints || {}) as Record<
      string,
      {
        read?: string[];
        write?: string[];
        edit?: string[];
        delete?: string[];
        allowAnonymous?: boolean;
      }
    >;
    if (!endpoints[routePath]) {
      endpoints[routePath] = {
        read: [],
        write: [],
        edit: [],
        delete: [],
        allowAnonymous: false,
      };
      tenant.aclEndpoints = endpoints as Tenant['aclEndpoints'];
      await this.dataSource.getRepository(Tenant).save(tenant);
    }
    return endpoints[routePath];
  }

  private checkEndpointAccess(
    tenant: Tenant,
    accountRole: string,
    module: ModuleLike,
    accountGroups: string[],
    requestPath?: string,
  ) {
    const action =
      module.method === HttpMethod.GET
        ? 'read'
        : module.method === HttpMethod.POST
        ? 'write'
        : module.method === HttpMethod.PUT || module.method === HttpMethod.PATCH
        ? 'edit'
        : 'delete';

    const rolesConfig = (tenant.aclRoles || {}) as {
      roles?: Record<string, string[]>;
      groups?: Record<string, string[]>;
    };
    const roles = rolesConfig.roles || {};
    const groups = rolesConfig.groups || {};

    const roleKey = String(accountRole || '').toLowerCase();
    const directRoles = [
      roles[roleKey],
      roles[String(accountRole || '')],
    ].filter(Boolean) as string[][];

    const groupRoles = (accountGroups || [])
      .flatMap((group) => [
        groups[String(group || '').toLowerCase()],
        groups[String(group || '')],
      ])
      .filter(Boolean) as string[][];

    const effectiveRoles = new Set<string>();
    for (const roleList of [...directRoles, ...groupRoles]) {
      for (const roleName of roleList) {
        if (roleName) effectiveRoles.add(roleName);
      }
    }

    const endpointConfig = this.resolveEndpointConfig(tenant, module.routePath, requestPath);
    if (!endpointConfig) return false;
    const requiredPermissions = endpointConfig[action] || [];
    if (!Array.isArray(requiredPermissions) || requiredPermissions.length === 0) return false;

    const permissions = new Set<string>();
    for (const roleName of effectiveRoles) {
      const rolePermissions = roles[roleName] || roles[String(roleName).toLowerCase()] || [];
      for (const perm of rolePermissions) {
        if (perm) permissions.add(perm);
      }
    }

    return requiredPermissions.some((perm) => permissions.has(perm));
  }
}
