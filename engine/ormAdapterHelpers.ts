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

export const loadOrmModels = async (dataSource: DataSource, tenant: Tenant) => {
  const repo = dataSource.getRepository(OrmModel);
  return repo.find({
    where: { tenant: { id: tenant.id } },
    relations: ['sourceCode', 'compiledCode'],
    order: { path: 'ASC' },
  });
};
