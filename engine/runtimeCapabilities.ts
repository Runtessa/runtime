import type { DataSource } from 'typeorm';
import { GlobalModulePackage, Tenant } from '@idp/shared';
import type { CryptoService } from '../core/security/CryptoService';
import { resolveGlobalDataSource } from '../core/globalDatasource';
import { AdapterSecretService } from './adapterSecretService';
import { RuntimeAdapterConnections } from './runtimeAdapterConnections';
import { resolveRuntimeStageFromEnv } from './adapterSecretRefs';
import { loadOrmModels } from './ormAdapterHelpers';
import { resolveTenantDirectoryAuthConfig } from './adapterTenantDirectoryConfig';
import { validateTenantPostgresConfig } from '@idp/shared/dist/runtime/postgres-config';
import { createRedisCapability } from './runtimeRedisCapability';

export const createRuntimeCapabilities = (dataSource: DataSource, crypto: CryptoService, tenant: Tenant, allowDraft: boolean) => {
  const secrets = new AdapterSecretService(dataSource, crypto, resolveRuntimeStageFromEnv());
  const connections = new RuntimeAdapterConnections(secrets);
  const redis = createRedisCapability(tenant, secrets, connections);
  const configurations = new Map<string, Promise<string>>();
  const call = async (operation: string, value: any): Promise<unknown> => {
    if (operation === 'redis') return redis.call(value);
    if (operation === 'models') {
      if (typeof value?.adapterKey !== 'string') throw new Error('Invalid model capability');
      const [adapter, ...rest] = value.adapterKey.split(':');
      connections.ensureAdapterAccess(tenant, adapter, rest.join(':'));
      return loadOrmModels(dataSource, tenant, value.adapterKey, allowDraft);
    }
    if (operation === 'adapter-config') {
      if (!value || !['postgres', 'mysql', 'mssql', 'redis', 'kafka', 's3'].includes(value.adapter) ||
          typeof value.key !== 'string' || value.key.length > 200 || !['read', 'write'].includes(value.mode)) throw new Error('Invalid adapter capability');
      // The parent owns the tenant and grants. Never accept them from child code.
      connections.ensureAdapterAccess(tenant, value.adapter, value.key);
      if (value.adapter === 'redis') throw new Error('Redis credentials stay in the parent; use the scoped adapter');
      const cacheKey = JSON.stringify([value.adapter, value.key, value.mode]);
      if (!configurations.has(cacheKey)) {
        if (configurations.size >= 16) throw new Error('Adapter configuration budget exceeded');
        configurations.set(cacheKey, (async () => {
          const raw = await secrets.resolveSecretValue(tenant, value.adapter, value.key, value.mode);
          const selected = secrets.selectReadWriteConfig(raw, value.mode);
          if (value.adapter === 'postgres') await validateTenantPostgresConfig(selected);
          return typeof selected === 'string' ? selected : JSON.stringify(selected);
        })());
      }
      return configurations.get(cacheKey)!;
    }
    if (operation === 'directory-config') return resolveTenantDirectoryAuthConfig(tenant, secrets);
    if (operation === 'shared-package') {
      if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 ||
          typeof value.version !== 'string' || value.version.length > 100) throw new Error('Invalid shared package capability');
      const globalSource = await resolveGlobalDataSource(dataSource);
      const repo = globalSource.getRepository(GlobalModulePackage);
      const relations = allowDraft ? ['compiledCode'] : ['publishedCompiledCode'];
      const row = value.version === 'latest'
        ? (await repo.find({ where: { name: value.name.trim() }, relations, order: { createdAt: 'DESC' }, take: 1 }))[0]
        : await repo.findOne({ where: { name: value.name.trim(), version: value.version }, relations });
      if (!row) return null;
      // Draft choice is fixed by the authenticated parent request.
      return { name: row.name, version: row.version, draftVersion: allowDraft ? row.draftVersion : undefined,
        publishedVersion: row.publishedVersion,
        ...(allowDraft ? { compiledCode: row.compiledCode } : { publishedCompiledCode: row.publishedCompiledCode }) };
    }
    throw new Error('Runtime capability denied');
  };
  return Object.assign(call, { dispose: () => redis.dispose() });
};
