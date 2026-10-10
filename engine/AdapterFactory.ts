import { DataSource } from 'typeorm';
import {
  MssqlAdapter,
  MysqlAdapter,
  OrmAdapter,
  PostgresAdapter,
  ReadWriteFactory,
  SandboxAdapters,
  SharedModuleAdapter,
  TenantDirectoryOrgResponse,
  TenantDirectoryOuResponse,
  TenantDirectoryUsersResponse,
} from './adapterTypes';
import { CircuitBreaker } from '../core/resilience/CircuitBreaker';
import { CryptoService } from '../core/security/CryptoService';
import { Tenant } from '@idp/shared';
import { CompilerAdapter } from './adapters/CompilerAdapter';
import { loadOrmEntitiesFromModels } from '../core/orm-loader';
export * from './adapterTypes';
import { resolveRuntimeStageFromEnv } from './adapterSecretRefs';
import { AdapterSecretService } from './adapterSecretService';
import { createTenantDirectoryAdapter } from './adapterTenantDirectory';
import { createHttpAdapter } from './adapterHttp';
import { SharedModuleLoader } from './sharedModuleLoader';
import { RuntimeAdapterConnections } from './runtimeAdapterConnections';
import { loadOrmModels, parseOrmAdapterKey } from './ormAdapterHelpers';
import { resolveTenantDirectoryAuthConfig, type TenantDirectoryAuthConfig } from './adapterTenantDirectoryConfig';
import { createRuntimeCapabilities } from './runtimeCapabilities';

export class AdapterFactory {
  private sharedModuleCache: Map<string, unknown> = new Map();
  private ormCache: Map<string, { dataSource: DataSource; entities: Record<string, any>; key: string }> =
    new Map();

  private compilerAdapter: CompilerAdapter;
  private runtimeStage: string;
  private readonly httpBreaker = new CircuitBreaker();
  private readonly secretService: AdapterSecretService;
  private readonly sharedModuleLoader: SharedModuleLoader;
  private readonly connections: RuntimeAdapterConnections;

  constructor(private readonly dataSource: DataSource, private readonly cryptoService: CryptoService,
    secretService?: AdapterSecretService,
    private readonly directoryConfig?: () => Promise<TenantDirectoryAuthConfig>,
  ) {
    this.compilerAdapter = new CompilerAdapter();
    this.runtimeStage = resolveRuntimeStageFromEnv();
    this.secretService = secretService ?? new AdapterSecretService(dataSource, cryptoService, this.runtimeStage);
    this.sharedModuleLoader = new SharedModuleLoader(dataSource, this.sharedModuleCache);
    this.connections = new RuntimeAdapterConnections(this.secretService);
  }

  runtimeCapabilities(tenant: Tenant, allowDraft: boolean) {
    return createRuntimeCapabilities(this.dataSource, this.cryptoService, tenant, allowDraft);
  }

  build(
    tenant: Tenant,
    options?: { allowDraftSharedModules?: boolean }
  ): SandboxAdapters {
    const postgres = ((key: string) =>
      this.connections.buildPostgres(tenant, key, 'write')) as ReadWriteFactory<PostgresAdapter>;
    postgres.readOnly = (key: string) => this.connections.buildPostgres(tenant, key, 'read');
    postgres.readWrite = (key: string) => this.connections.buildPostgres(tenant, key, 'write');

    const mysql = ((key: string) =>
      this.connections.buildMysql(tenant, key, 'write')) as ReadWriteFactory<MysqlAdapter>;
    mysql.readOnly = (key: string) => this.connections.buildMysql(tenant, key, 'read');
    mysql.readWrite = (key: string) => this.connections.buildMysql(tenant, key, 'write');

    const mssql = ((key: string) =>
      this.connections.buildMssql(tenant, key, 'write')) as ReadWriteFactory<MssqlAdapter>;
    mssql.readOnly = (key: string) => this.connections.buildMssql(tenant, key, 'read');
    mssql.readWrite = (key: string) => this.connections.buildMssql(tenant, key, 'write');
    const orm = ((key: string) => this.buildOrm(tenant, key, 'write')) as ReadWriteFactory<OrmAdapter>;
    orm.readOnly = (key: string) => this.buildOrm(tenant, key, 'read');
    orm.readWrite = (key: string) => this.buildOrm(tenant, key, 'write');
    const allowDraftSharedModules = Boolean(options?.allowDraftSharedModules);
    const shared: SharedModuleAdapter = {
      require: (name: string, version?: string) =>
        this.sharedModuleLoader.load(name, version, allowDraftSharedModules),
    };
    const tenantDirectory = this.buildTenantDirectoryAdapter(tenant);

    return {
      postgres,
      mysql,
      mssql,
      orm,
      redis: (envKey) => this.connections.buildRedis(tenant, envKey),
      kafka: (envKey) => this.connections.buildKafka(tenant, envKey),
      s3: (envKey) => this.connections.buildS3(tenant, envKey),
      shared,
      http: this.buildHttpAdapter(tenant),
      compiler: this.compilerAdapter,
      getOrg: () => tenantDirectory.getOrg(),
      getOU: (ouPath: string) => tenantDirectory.getOU(ouPath),
      getUsers: (ouPath: string) => tenantDirectory.getUsers(ouPath),
    };
  }

  private async buildOrm(
    tenant: Tenant,
    rawKey: string | undefined,
    mode: 'read' | 'write',
  ): Promise<OrmAdapter> {
    const parsed = parseOrmAdapterKey(rawKey);
    const adapter = parsed.adapter;
    let key = parsed.key;
    if (!key) {
      const access = tenant.adapterAccess ?? {};
      const rule = (access as Record<string, { allow?: string[] } | undefined>)[adapter];
      const allow = rule?.allow ?? [];
      if (!allow.length) {
        throw new Error(`Access denied: ${adapter} adapter is not enabled for tenant`);
      }
      key = allow[0];
    }
    if (!['postgres', 'mysql', 'mssql'].includes(adapter)) {
      throw new Error(`Unsupported ORM adapter: ${adapter}`);
    }
    this.connections.ensureAdapterAccess(tenant, adapter, key);

    const models = await loadOrmModels(this.dataSource, tenant);
    if (!models.length) {
      throw new Error('No ORM models defined for tenant');
    }

    const modelsKey = models
      .map((model) => `${model.id}:${model.updatedAt?.getTime?.() ?? ''}`)
      .join('|');

    const secretVal = await this.secretService.resolveSecretValue(tenant, adapter, key, mode);
    const selectedConfig = this.secretService.selectReadWriteConfig(secretVal, mode);
    // ORM adapter keeps one initialized datasource; for array-based read replicas use the first entry.
    const config = Array.isArray(selectedConfig) ? selectedConfig[0] : selectedConfig;
    if (config === undefined || config === null) {
      throw new Error(`No ${mode} configuration found for ORM adapter ${adapter}:${key}`);
    }
    const configKey = typeof config === 'string' ? config : JSON.stringify(config ?? {});

    const cacheKey = `${tenant.id}:orm:${adapter}:${key}:${mode}`;
    const cacheEntry = this.ormCache.get(cacheKey);
    const combinedKey = `${modelsKey}:${configKey}`;
    if (cacheEntry && cacheEntry.key === combinedKey) {
      const getRepository = (name: string) => {
        const entity = cacheEntry.entities[name];
        if (!entity) {
          throw new Error(`ORM entity not found: ${name}`);
        }
        return cacheEntry.dataSource.getRepository(entity);
      };
      return {
        dataSource: cacheEntry.dataSource,
        entities: cacheEntry.entities,
        getRepository,
      };
    }
    if (cacheEntry) {
      try {
        await cacheEntry.dataSource.destroy();
      } catch {
        // ignore
      }
      this.ormCache.delete(cacheKey);
    }

    const { entities, entityMap } = loadOrmEntitiesFromModels(models);
    if (!entities.length) {
      throw new Error('No valid TypeORM entities found in models');
    }

    const dataSource = new DataSource({
      type: adapter as 'postgres' | 'mysql' | 'mssql',
      ...(typeof config === 'string'
        ? { url: config }
        : this.secretService.normalizeDbConfig(config as Record<string, unknown>)),
      entities,
      synchronize: false,
      logging: false,
    } as any);

    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }

    const getRepository = (name: string) => {
      const entity = entityMap[name];
      if (!entity) {
        throw new Error(`ORM entity not found: ${name}`);
      }
      return dataSource.getRepository(entity);
    };

    this.ormCache.set(cacheKey, {
      dataSource,
      entities: entityMap,
      key: combinedKey,
    });

    return { dataSource, entities: entityMap, getRepository };
  }

  private buildTenantDirectoryAdapter(tenant: Tenant): {
    getOrg: () => Promise<TenantDirectoryOrgResponse>;
    getOU: (ouPath: string) => Promise<TenantDirectoryOuResponse>;
    getUsers: (ouPath: string) => Promise<TenantDirectoryUsersResponse>;
  } {
    let configPromise: Promise<TenantDirectoryAuthConfig> | null = null;

    const readConfig = async () => {
      if (!configPromise) {
        configPromise = this.directoryConfig ? this.directoryConfig() : resolveTenantDirectoryAuthConfig(tenant, this.secretService);
      }
      return configPromise;
    };
    return createTenantDirectoryAdapter(readConfig);
  }

  private buildHttpAdapter(_tenant: Tenant) {
    return createHttpAdapter((execute) => this.httpBreaker.fire(execute));
  }
}
