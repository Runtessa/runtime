import { DataSource } from 'typeorm';
import { GlobalModulePackage, OrmModel, Tenant } from '@idp/shared';
import { AdapterFactory } from './AdapterFactory';
import { AdapterSecretService } from './adapterSecretService';
import { CryptoService } from '../core/security/CryptoService';

type Call = (operation: string, value?: any) => Promise<any>;
class ProcessSecrets extends AdapterSecretService {
  constructor(private readonly call: Call) { super(null as unknown as DataSource, null as unknown as CryptoService, 'production'); }
  async resolveSecretValue(_tenant: Tenant, adapter: string, key: string, mode: 'read' | 'write' = 'write') {
    return this.call('adapter-config', { adapter, key, mode });
  }
  async getSecretValue(_tenant: Tenant, _key: string) {
    return (await this.call('directory-config')).tenantSsoToken;
  }
}

// Only fixed data operations cross the boundary; no platform datasource or keys.
export const buildProcessAdapters = (tenant: Tenant, allowDraft: boolean, call: Call) => {
  const source = {
    getRepository(entity: unknown) {
      if (entity === OrmModel) return { find: async () => (await call('models')).map((model: any) => ({
        ...model, updatedAt: model.updatedAt ? new Date(model.updatedAt) : undefined,
      })) };
      if (entity === GlobalModulePackage) return {
        find: async (options: any) => {
          const pkg = await call('shared-package', { name: options.where.name, version: 'latest' });
          return pkg ? [pkg] : [];
        },
        findOne: async (options: any) => call('shared-package', { name: options.where.name, version: options.where.version }),
      };
      throw new Error('Platform repository unavailable in runtime');
    },
  } as unknown as DataSource;
  const secrets = new ProcessSecrets(call);
  const factory = new AdapterFactory(source, null as unknown as CryptoService, secrets, async () => call('directory-config'));
  return factory.build(tenant, { allowDraftSharedModules: allowDraft });
};
