import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Tenant } from '../entities/Tenant';
import { Account } from '../entities/Account';
import { Secret } from '../entities/Secret';
import { ModuleEntity } from '../entities/Module';
import { UIPackage } from '../entities/UIEntities';

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
  entities: [Tenant, Account, Secret, ModuleEntity, UIPackage],
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
