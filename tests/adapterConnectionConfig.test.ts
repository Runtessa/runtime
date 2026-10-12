import assert from 'node:assert/strict';
import { AdapterSecretService } from '../engine/adapterSecretService';

const service = new AdapterSecretService(null as any, null as any, 'dev');
assert.deepEqual(service.normalizeDbConfig({ user: 'tenant_user', database: 'tenant_db' }),
  { user: 'tenant_user', username: 'tenant_user', database: 'tenant_db' });
assert.deepEqual(service.normalizeDbConfig({ username: 'tenant_user' }),
  { user: 'tenant_user', username: 'tenant_user' });
assert.deepEqual(service.normalizeDbConfig({ username: 'explicit_orm', user: 'explicit_driver' }),
  { username: 'explicit_orm', user: 'explicit_driver' });
console.log('Tenant connection username aliases work for both native SQL drivers and ORM.');
