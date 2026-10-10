import type { DataSource } from 'typeorm';
import { GlobalModulePackage, Tenant } from '@idp/shared';
import type { CryptoService } from '../core/security/CryptoService';
import { resolveGlobalDataSource } from '../core/globalDatasource';
import { AdapterSecretService } from './adapterSecretService';
import { RuntimeAdapterConnections } from './runtimeAdapterConnections';
import { resolveRuntimeStageFromEnv } from './adapterSecretRefs';
import { loadOrmModels } from './ormAdapterHelpers';
import { resolveTenantDirectoryAuthConfig } from './adapterTenantDirectoryConfig';

export const createRuntimeCapabilities = (dataSource: DataSource, crypto: CryptoService, tenant: Tenant, allowDraft: boolean) => {
  const secrets = new AdapterSecretService(dataSource, crypto, resolveRuntimeStageFromEnv());
  const connections = new RuntimeAdapterConnections(secrets);
  return async (operation: string, value: any): Promise<unknown> => {
    if (operation === 'models') return loadOrmModels(dataSource, tenant);
    if (operation === 'adapter-config') {
      if (!value || !['postgres', 'mysql', 'mssql', 'redis', 'kafka', 's3'].includes(value.adapter) ||
          typeof value.key !== 'string' || !['read', 'write'].includes(value.mode)) throw new Error('Invalid adapter capability');
      // The parent owns the tenant and grants. Never accept them from child code.
      connections.ensureAdapterAccess(tenant, value.adapter, value.key);
      const raw = await secrets.resolveSecretValue(tenant, value.adapter, value.key, value.mode);
      const selected = secrets.selectReadWriteConfig(raw, value.mode);
      return typeof selected === 'string' ? selected : JSON.stringify(selected);
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
};
