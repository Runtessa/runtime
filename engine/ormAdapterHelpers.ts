import { DataSource } from 'typeorm';
import { OrmModel, Tenant } from '@idp/shared';

export const parseOrmAdapterKey = (raw: string | undefined | null) => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { adapter: 'postgres', key: '' };
  }
  if (trimmed.includes(':')) {
    const [adapter, ...rest] = trimmed.split(':');
    return { adapter: adapter.toLowerCase(), key: rest.join(':') };
  }
  return { adapter: 'postgres', key: trimmed };
};

export const loadOrmModels = async (dataSource: DataSource, tenant: Tenant, adapterKey: string, draft = false) => {
  if (!draft) {
    const [state] = await dataSource.query('SELECT active_models, active_revision FROM runtessa_model_state WHERE tenant_id = $1 AND adapter_key = $2', [tenant.id, adapterKey]);
    if (!state?.active_models?.length) throw Object.assign(new Error('Activate the tenant models before using the published ORM'), { statusCode: 409 });
    return state.active_models.map((model: { path: string; code: string }) => ({
      path: model.path, compiledCode: { code: model.code }, sourceCode: null, activeRevision: state.active_revision,
    })) as OrmModel[];
  }
  const repo = dataSource.getRepository(OrmModel);
  return repo.find({
    where: { tenant: { id: tenant.id } },
    relations: ['sourceCode', 'compiledCode'],
    order: { path: 'ASC' },
  });
};
