import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Tenant } from '@idp/shared';
import { Account } from '@idp/shared';
import { Secret } from '@idp/shared';
import { ModuleEntity } from '@idp/shared';
import { UIPackage } from '@idp/shared';
import { ModuleRevision } from '@idp/shared';
import { OrmModel } from '@idp/shared';
import { UIPackageRevision } from '@idp/shared';
import { GlobalModuleEndpoint } from '@idp/shared';
import { GlobalModulePackage } from '@idp/shared';
import { GlobalModulePackageFile } from '@idp/shared';
import { GlobalUIPackage } from '@idp/shared';
import { GlobalUIPackageFile } from '@idp/shared';
import { PublishRequest } from '@idp/shared';
import { User } from '@idp/shared';
import { SourceCode } from '@idp/shared';
import { CompiledCode } from '@idp/shared';
import { TenantNpmPackageBuild } from '@idp/shared';
import { OrchestrationAgent } from '@idp/shared';
import { OrchestrationOperation } from '@idp/shared';
import { OrchestrationPlacement } from '@idp/shared';
import { OrchestrationWorkload } from '@idp/shared';
import { safeErrorMeta } from '@idp/shared';
import { SafeDatabaseLogger } from './safeDatabaseLogger';

const connectionOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: true,
  logging: process.env.DB_LOGGING === 'true',
  logger: new SafeDatabaseLogger(process.env.DB_LOGGING === 'true'),
  entities: [
    Tenant,
    Account,
    User,
    Secret,
    ModuleEntity,
    UIPackage,
    GlobalModuleEndpoint,
    GlobalModulePackage,
    GlobalModulePackageFile,
    GlobalUIPackage,
    GlobalUIPackageFile,
    ModuleRevision,
    UIPackageRevision,
    SourceCode,
    CompiledCode,
    TenantNpmPackageBuild,
    OrmModel,
    PublishRequest,
    OrchestrationAgent,
    OrchestrationWorkload,
    OrchestrationPlacement,
    OrchestrationOperation,
  ],
  subscribers: [],
  migrations: [],
};

export const AppDataSource = new DataSource(connectionOptions);

export const initializeDataSource = async (): Promise<DataSource> => {
  if (AppDataSource.isInitialized) {
    return AppDataSource;
  }

  try {
    return await AppDataSource.initialize();
  } catch (error) {
    // Avoid leaking credentials and keep logs minimal for production readiness
    console.error('Failed to initialize database connection:', safeErrorMeta(error));
    throw error;
  }
};
