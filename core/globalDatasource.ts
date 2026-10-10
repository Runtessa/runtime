import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { safeErrorMeta } from '@idp/shared';
import { platformConnectionOptions } from '@idp/shared/dist/database/connection-options';
import { initializePlatformDataSource } from '@idp/shared/dist/database/schema-readiness';

const CoreGlobalDataSource = new DataSource(platformConnectionOptions('catalog'));
let loggedError = false;
const hasCoreEnv = () => Boolean(process.env.CORE_DATABASE_URL || process.env.CORE_DB_NAME ||
  process.env.CORE_DB_HOST || process.env.CORE_DB_USER || process.env.CORE_DB_PASS);

export const getCoreGlobalDataSource = () => initializePlatformDataSource(CoreGlobalDataSource, 'catalog');

export const resolveGlobalDataSource = async (fallback: DataSource) => {
  if (!hasCoreEnv()) return fallback;
  try { return await getCoreGlobalDataSource(); }
  catch (error) {
    if (!loggedError) {
      console.warn('Global package DB unavailable, falling back to app DB:', safeErrorMeta(error));
      loggedError = true;
    }
    return fallback;
  }
};
