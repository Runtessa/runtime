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
    OrmModel,
    PublishRequest,
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
    console.error('Failed to initialize database connection:', (error as Error).message);
    throw error;
  }
};
