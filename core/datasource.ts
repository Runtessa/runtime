import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { safeErrorMeta } from '@idp/shared';
import { platformConnectionOptions } from '@idp/shared/dist/database/connection-options';
import { initializePlatformDataSource } from '@idp/shared/dist/database/schema-readiness';
import { SafeDatabaseLogger } from './safeDatabaseLogger';

export const AppDataSource = new DataSource({
  ...platformConnectionOptions('core'),
  logging: process.env.DB_LOGGING === 'true',
  logger: new SafeDatabaseLogger(process.env.DB_LOGGING === 'true'),
});

export const initializeDataSource = async (): Promise<DataSource> => {
  try { return await initializePlatformDataSource(AppDataSource, 'core'); }
  catch (error) {
    console.error('Failed to initialize database connection:', safeErrorMeta(error));
    throw error;
  }
};
