import { DataSource } from 'typeorm';
import { CompilerAdapter } from './adapters/CompilerAdapter';

export type AsyncFactory<T> = (envKey: string) => Promise<T>;

export type ReadWriteFactory<T> = {
  (key: string): Promise<T>;
  readOnly: (key: string) => Promise<T>;
  readWrite: (key: string) => Promise<T>;
};

export interface PostgresAdapter {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
}

export interface MysqlAdapter {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
}

export interface MssqlAdapter {
  query: (sql: string) => Promise<unknown[]>;
}

export interface RedisAdapter {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds?: number) => Promise<'OK'>;
  del: (key: string) => Promise<number>;
  publish: (channel: string, message: string) => Promise<number>;
}

export interface KafkaAdapter {
  publish: (topic: string, messages: { key?: string; value: string }[]) => Promise<void>;
}

export interface S3Adapter {
  putObject: (params: { bucket: string; key: string; body: Buffer | string }) => Promise<void>;
  getSignedUrl: (params: { bucket: string; key: string; expiresIn?: number }) => Promise<string>;
}

export interface SharedModuleAdapter {
  require: (name: string, version?: string) => Promise<unknown>;
}

export interface OrmAdapter {
  dataSource: DataSource;
  entities: Record<string, any>;
  getRepository: (name: string) => any;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown>;
  timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface TenantDirectoryOrganization {
  randId: string;
  code: string;
  name: string;
  parentOrgRandId: string | null;
  path: string;
  depth: number;
}

export interface TenantDirectoryUser {
  randId: string;
  email: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  organizations: Array<{
    orgRandId: string;
    orgCode: string | null;
    orgName: string | null;
    orgPath: string | null;
  }>;
  roles: Array<{
    roleRandId: string;
    roleCode: string;
    roleName: string;
    orgRandId: string;
    orgPath: string | null;
  }>;
  signupContext: {
    orgRandId: string | null;
    source: string;
    changedAt: string;
  } | null;
}

export interface TenantDirectoryOrgResponse {
  tenantName: string;
  rootOrg: TenantDirectoryOrganization | null;
  organizations: TenantDirectoryOrganization[];
  builtAt: string;
  cacheTtlSec: number;
}

export interface TenantDirectoryOuResponse {
  tenantName: string;
  ou: TenantDirectoryOrganization;
  descendants: TenantDirectoryOrganization[];
  builtAt: string;
  cacheTtlSec: number;
}

export interface TenantDirectoryUsersResponse {
  tenantName: string;
  ou: TenantDirectoryOrganization;
  users: TenantDirectoryUser[];
  total: number;
  builtAt: string;
  cacheTtlSec: number;
}

export interface SandboxAdapters {
  postgres: ReadWriteFactory<PostgresAdapter>;
  mysql: ReadWriteFactory<MysqlAdapter>;
  mssql: ReadWriteFactory<MssqlAdapter>;
  orm: ReadWriteFactory<OrmAdapter>;
  redis: AsyncFactory<RedisAdapter>;
  kafka: AsyncFactory<KafkaAdapter>;
  s3: AsyncFactory<S3Adapter>;
  shared: SharedModuleAdapter;
  http?: {
    request: (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;
  };
  compiler?: CompilerAdapter;
  getOrg: () => Promise<TenantDirectoryOrgResponse>;
  getOU: (ouPath: string) => Promise<TenantDirectoryOuResponse>;
  getUsers: (ouPath: string) => Promise<TenantDirectoryUsersResponse>;
}
