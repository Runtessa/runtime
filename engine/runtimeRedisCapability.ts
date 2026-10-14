import Redis from 'ioredis';
import type { Tenant } from '@idp/shared';
import { authorizeNetworkTarget } from '@idp/shared/dist/runtime/network-policy';
import type { AdapterSecretService } from './adapterSecretService';
import type { RuntimeAdapterConnections } from './runtimeAdapterConnections';

export const createRedisCapability = (tenant: Tenant, secrets: AdapterSecretService, connections: RuntimeAdapterConnections) => {
  const clients = new Map<string, Promise<Redis>>();
  let closed = false;
  const connect = async (key: string) => {
    connections.ensureAdapterAccess(tenant, 'redis', key);
    const raw = await secrets.resolveSecretValue(tenant, 'redis', key, 'write');
    let config: any;
    try { config = JSON.parse(raw); } catch { config = raw; }
    if (typeof config?.url === 'string') config = config.url;
    if (typeof config === 'string') {
      const url = new URL(config);
      config = { host: url.hostname, port: Number(url.port || 6379), username: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined, db: Number(url.pathname.slice(1) || 0), ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}) };
    }
    const target = await authorizeNetworkTarget({ host: config?.host || '127.0.0.1', port: Number(config?.port || 6379) }, false, true);
    if (closed) throw new Error('Runtime capability closed');
    const client = new Redis({ ...config, host: target.address, port: target.port, lazyConnect: true, connectTimeout: 3000,
      maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    client.on('error', () => {});
    try { await client.connect(); if (closed) throw new Error('Runtime capability closed'); return client; }
    catch (error) { client.disconnect(); throw error; }
  };
  return {
    async call(value: any) {
      if (closed || !value || typeof value.key !== 'string' || value.key.length > 200 || !['get','set','del','publish'].includes(value.command)
        || typeof value.name !== 'string' || value.name.length > 512 || !value.name.length) throw new Error('Invalid Redis capability');
      if (['set','publish'].includes(value.command) && (typeof value.value !== 'string' || Buffer.byteLength(value.value) > 256 * 1024)) throw new Error('Redis value exceeds runtime budget');
      if (value.ttl !== undefined && (!Number.isInteger(value.ttl) || value.ttl < 1 || value.ttl > 86400 * 30)) throw new Error('Invalid Redis TTL');
      if (!clients.has(value.key)) {
        if (clients.size >= 16) throw new Error('Redis connection budget exceeded');
        clients.set(value.key, connect(value.key));
      }
      const client = await clients.get(value.key)!;
      const name = `runtessa:${tenant.id}:${value.name}`;
      if (value.command === 'get') {
        const result = await client.get(name);
        if (result && Buffer.byteLength(result) > 256 * 1024) throw new Error('Redis value exceeds runtime budget');
        return result;
      }
      if (value.command === 'del') return client.del(name);
      if (value.command === 'publish') return client.publish(name, value.value);
      return client.set(name, value.value, 'EX', value.ttl || 86400);
    },
    async dispose() { closed = true; await Promise.allSettled([...clients.values()].map(async (pending) => (await pending).disconnect())); },
  };
};
