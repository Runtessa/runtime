import { Pool as PgPool } from 'pg';
import { createPool as createMySqlPool } from 'mysql2/promise';
import { ConnectionPool, config as MssqlConfig } from 'mssql';
import Redis from 'ioredis';
import { Kafka, Producer } from 'kafkajs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Tenant } from '@idp/shared';
import { CircuitBreaker } from '../core/resilience/CircuitBreaker';
import {
  KafkaAdapter,
  MssqlAdapter,
  MysqlAdapter,
  PostgresAdapter,
  RedisAdapter,
  S3Adapter,
} from './adapterTypes';
import { AdapterSecretService } from './adapterSecretService';

export class RuntimeAdapterConnections {
  private pgPools: Map<string, PgPool | PgPool[]> = new Map();
  private mysqlPools: Map<
    string,
    ReturnType<typeof createMySqlPool> | ReturnType<typeof createMySqlPool>[]
  > = new Map();
  private mssqlPools: Map<string, ConnectionPool | ConnectionPool[]> = new Map();
  private redisClients: Map<string, Redis> = new Map();
  private kafkaProducers: Map<string, Producer> = new Map();
  private s3Clients: Map<string, S3Client> = new Map();
  private breakers: Map<string, CircuitBreaker> = new Map();
  private adapterRoundRobinCursor: Map<string, number> = new Map();

  constructor(private readonly secretService: AdapterSecretService) {}

  async buildPostgres(
    tenant: Tenant,
    adapterKey: string,
    mode: 'read' | 'write',
  ): Promise<PostgresAdapter> {
    this.ensureAdapterAccess(tenant, 'postgres', adapterKey);
    const normalizedKey = adapterKey.trim().toLowerCase();
    const cacheKey = `${tenant.id}:pg:${normalizedKey}:${mode}`;
    if (!this.pgPools.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 'postgres', normalizedKey, mode);
      const config = this.secretService.selectReadWriteConfig(secretVal, mode);
      if (config === undefined || config === null) {
        throw new Error(`No ${mode} postgres configuration found for ${normalizedKey}`);
      }
      if (Array.isArray(config)) {
        const pools = config
          .filter((entry) => entry !== undefined && entry !== null)
          .map((entry) =>
            typeof entry === 'string'
              ? new PgPool({ connectionString: entry })
              : new PgPool(this.secretService.normalizeDbConfig(entry as Record<string, unknown>)),
          );
        if (!pools.length) {
          throw new Error(`No ${mode} postgres connection entries found for ${normalizedKey}`);
        }
        this.pgPools.set(cacheKey, pools.length === 1 ? pools[0] : pools);
      } else if (typeof config === 'string') {
        this.pgPools.set(cacheKey, new PgPool({ connectionString: config }));
      } else {
        this.pgPools.set(
          cacheKey,
          new PgPool(this.secretService.normalizeDbConfig(config as Record<string, unknown>)),
        );
      }
    }
    const poolSource = this.pgPools.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      query: async (sql: string, params?: unknown[]) =>
        breaker.fire(async () => {
          const pool = this.pickAdapterInstance(cacheKey, poolSource);
          const client = await pool.connect();
          try {
            const result = await client.query(sql, params as unknown[] | undefined);
            return result.rows;
          } finally {
            client.release();
          }
        }),
    };
  }

  async buildMysql(
    tenant: Tenant,
    adapterKey: string,
    mode: 'read' | 'write',
  ): Promise<MysqlAdapter> {
    this.ensureAdapterAccess(tenant, 'mysql', adapterKey);
    const normalizedKey = adapterKey.trim().toLowerCase();
    const cacheKey = `${tenant.id}:mysql:${normalizedKey}:${mode}`;
    if (!this.mysqlPools.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 'mysql', normalizedKey, mode);
      const config = this.secretService.selectReadWriteConfig(secretVal, mode);
      if (config === undefined || config === null) {
        throw new Error(`No ${mode} mysql configuration found for ${normalizedKey}`);
      }
      if (Array.isArray(config)) {
        const pools = config
          .filter((entry) => entry !== undefined && entry !== null)
          .map((entry) =>
            typeof entry === 'string'
              ? createMySqlPool({ uri: entry })
              : createMySqlPool(this.secretService.normalizeDbConfig(entry as Record<string, unknown>)),
          );
        if (!pools.length) {
          throw new Error(`No ${mode} mysql connection entries found for ${normalizedKey}`);
        }
        this.mysqlPools.set(cacheKey, pools.length === 1 ? pools[0] : pools);
      } else if (typeof config === 'string') {
        this.mysqlPools.set(cacheKey, createMySqlPool({ uri: config }));
      } else {
        this.mysqlPools.set(
          cacheKey,
          createMySqlPool(this.secretService.normalizeDbConfig(config as Record<string, unknown>)),
        );
      }
    }
    const poolSource = this.mysqlPools.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      query: async (sql: string, params?: unknown[]) =>
        breaker.fire(async () => {
          const pool = this.pickAdapterInstance(cacheKey, poolSource);
          const [rows] = await pool.query(sql, params as unknown[] | undefined);
          return Array.isArray(rows) ? rows : [];
        }),
    };
  }

  async buildMssql(
    tenant: Tenant,
    adapterKey: string,
    mode: 'read' | 'write',
  ): Promise<MssqlAdapter> {
    this.ensureAdapterAccess(tenant, 'mssql', adapterKey);
    const normalizedKey = adapterKey.trim().toLowerCase();
    const cacheKey = `${tenant.id}:mssql:${normalizedKey}:${mode}`;
    if (!this.mssqlPools.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 'mssql', normalizedKey, mode);
      const config = this.secretService.selectReadWriteConfig(secretVal, mode);
      if (config === undefined || config === null) {
        throw new Error(`No ${mode} mssql configuration found for ${normalizedKey}`);
      }
      if (Array.isArray(config)) {
        const pools = config
          .filter((entry) => entry !== undefined && entry !== null)
          .map((entry) =>
            typeof entry === 'string'
              ? new ConnectionPool(entry)
              : new ConnectionPool(
                  this.secretService.normalizeDbConfig(
                    entry as Record<string, unknown>,
                  ) as unknown as MssqlConfig,
                ),
          );
        if (!pools.length) {
          throw new Error(`No ${mode} mssql connection entries found for ${normalizedKey}`);
        }
        await Promise.all(pools.map((pool) => pool.connect()));
        this.mssqlPools.set(cacheKey, pools.length === 1 ? pools[0] : pools);
      } else {
        const pool =
          typeof config === 'string'
            ? new ConnectionPool(config)
            : new ConnectionPool(
                this.secretService.normalizeDbConfig(
                  config as Record<string, unknown>,
                ) as unknown as MssqlConfig,
              );
        await pool.connect();
        this.mssqlPools.set(cacheKey, pool);
      }
    }
    const poolSource = this.mssqlPools.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      query: async (sql: string) =>
        breaker.fire(async () => {
          const pool = this.pickAdapterInstance(cacheKey, poolSource);
          const result = await pool.request().query(sql);
          return result.recordset;
        }),
    };
  }

  async buildRedis(tenant: Tenant, envKey: string): Promise<RedisAdapter> {
    this.ensureAdapterAccess(tenant, 'redis', envKey);
    const cacheKey = `${tenant.id}:redis:${envKey}`;
    if (!this.redisClients.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 'redis', envKey, 'write');
      let config: string | Record<string, unknown> = secretVal;
      try {
        const parsed = JSON.parse(secretVal);
        if (parsed && typeof parsed === 'object') {
          const url = (parsed as any).url;
          config = typeof url === 'string' ? url : (parsed as Record<string, unknown>);
        }
      } catch {
        // use raw string
      }
      this.redisClients.set(cacheKey, new Redis(config as any));
    }
    const client = this.redisClients.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      get: async (key: string) => breaker.fire(async () => client.get(key)),
      set: async (key: string, value: string, ttlSeconds?: number) =>
        breaker.fire(async () => {
          if (ttlSeconds) {
            return client.set(key, value, 'EX', ttlSeconds);
          }
          return client.set(key, value);
        }),
      del: async (key: string) => breaker.fire(async () => client.del(key)),
      publish: async (channel: string, message: string) =>
        breaker.fire(async () => client.publish(channel, message)),
    };
  }

  async buildKafka(tenant: Tenant, envKey: string): Promise<KafkaAdapter> {
    this.ensureAdapterAccess(tenant, 'kafka', envKey);
    const cacheKey = `${tenant.id}:kafka:${envKey}`;
    if (!this.kafkaProducers.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 'kafka', envKey, 'write');
      let brokers: string[] = [];
      try {
        const parsed = JSON.parse(secretVal);
        brokers = parsed.brokers || [];
      } catch {
        brokers = secretVal.split(',').map((s) => s.trim());
      }
      const kafka = new Kafka({ clientId: `tenant-${tenant.id}`, brokers });
      const producer = kafka.producer();
      await producer.connect();
      this.kafkaProducers.set(cacheKey, producer);
    }
    const producer = this.kafkaProducers.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      publish: async (topic: string, messages: { key?: string; value: string }[]) =>
        breaker.fire(async () => {
          await producer.send({
            topic,
            messages: messages.map((m) => ({ key: m.key, value: m.value })),
          });
        }),
    };
  }

  async buildS3(tenant: Tenant, envKey: string): Promise<S3Adapter> {
    this.ensureAdapterAccess(tenant, 's3', envKey);
    const cacheKey = `${tenant.id}:s3:${envKey}`;
    if (!this.s3Clients.has(cacheKey)) {
      const secretVal = await this.secretService.resolveSecretValue(tenant, 's3', envKey, 'write');
      let cfg: {
        endpoint?: string;
        region?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        forcePathStyle?: boolean;
      } = {};
      try {
        cfg = JSON.parse(secretVal);
      } catch {
        cfg = { endpoint: undefined, region: 'us-east-1' };
      }
      const client = new S3Client({
        region: cfg.region || 'us-east-1',
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle ?? !!cfg.endpoint,
        credentials:
          cfg.accessKeyId && cfg.secretAccessKey
            ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
            : undefined,
      });
      this.s3Clients.set(cacheKey, client);
    }
    const client = this.s3Clients.get(cacheKey)!;
    const breaker = this.breakerFor(cacheKey);
    return {
      putObject: async (params: { bucket: string; key: string; body: Buffer | string }) =>
        breaker.fire(async () => {
          await client.send(
            new PutObjectCommand({
              Bucket: params.bucket,
              Key: params.key,
              Body: params.body,
            }),
          );
        }),
      getSignedUrl: async (params: { bucket: string; key: string; expiresIn?: number }) =>
        breaker.fire(async () => {
          const command = new GetObjectCommand({ Bucket: params.bucket, Key: params.key });
          return getSignedUrl(client, command, { expiresIn: params.expiresIn ?? 900 });
        }),
    };
  }

  ensureAdapterAccess(tenant: Tenant, adapter: string, adapterKey: string) {
    const rawKey = adapterKey.trim();
    const lowerKey = rawKey.toLowerCase();
    const access = tenant.adapterAccess || {};
    const rule = (access as Record<string, { allow?: string[] } | undefined>)[adapter];
    const allow = rule?.allow ?? [];
    if (allow.length === 0) {
      throw new Error(`Access denied: ${adapter} adapter is not enabled for tenant`);
    }
    if (allow.includes('*')) return;
    if (!allow.includes(rawKey) && !allow.includes(lowerKey)) {
      throw new Error(`Access denied: ${adapter} adapter cannot access ${rawKey}`);
    }
  }

  private breakerFor(key: string): CircuitBreaker {
    let br = this.breakers.get(key);
    if (!br) {
      br = new CircuitBreaker();
      this.breakers.set(key, br);
    }
    return br;
  }

  private nextRoundRobinIndex(key: string, length: number): number {
    if (length <= 1) return 0;
    const current = this.adapterRoundRobinCursor.get(key) ?? 0;
    const index = current % length;
    this.adapterRoundRobinCursor.set(key, (index + 1) % length);
    return index;
  }

  private pickAdapterInstance<T>(cacheKey: string, value: T | T[]): T {
    if (!Array.isArray(value)) return value;
    if (value.length === 0) {
      throw new Error(`No adapter instances configured for ${cacheKey}`);
    }
    const index = this.nextRoundRobinIndex(cacheKey, value.length);
    return value[index]!;
  }
}
