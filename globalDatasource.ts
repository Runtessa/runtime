import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { GlobalUIPackage } from '../entities/GlobalUIPackage';
import { GlobalUIPackageFile } from '../entities/GlobalUIPackageFile';

const dbType = (process.env.CORE_DB_TYPE ||
  process.env.DB_TYPE ||
  'postgres') as DataSourceOptions['type'];
const dbName = process.env.CORE_DB_NAME || process.env.DB_NAME;

const normalizeDatabaseUrl = (rawUrl?: string, name?: string) => {
  if (!rawUrl || !name) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname && parsed.pathname !== '/') {
      return rawUrl;
    }
    parsed.pathname = `/${name}`;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

const databaseUrl = normalizeDatabaseUrl(
  process.env.CORE_DATABASE_URL || process.env.DATABASE_URL,
  dbName
);

const coreOptions = {
  type: dbType,
  url: databaseUrl,
  database: dbName,
  logging: false,
  synchronize: false,
  entities: [GlobalUIPackage, GlobalUIPackageFile],
} as DataSourceOptions;

const CoreGlobalDataSource = new DataSource(coreOptions);

let initPromise: Promise<DataSource> | null = null;
let loggedError = false;

const hasCoreEnv = () =>
  Boolean(
    process.env.CORE_DATABASE_URL ||
      process.env.CORE_DB_NAME ||
      process.env.CORE_DB_HOST ||
      process.env.CORE_DB_USER ||
      process.env.CORE_DB_PASS
  );

export const getCoreGlobalDataSource = async () => {
  if (CoreGlobalDataSource.isInitialized) return CoreGlobalDataSource;
  if (initPromise) return initPromise;
  initPromise = CoreGlobalDataSource.initialize()
    .then(async () => {
      const allowSync =
        process.env.CORE_DB_SYNC === 'true' || process.env.NODE_ENV !== 'production';
      if (allowSync) {
        const queryRunner = CoreGlobalDataSource.createQueryRunner();
        try {
          const hasGlobalTable = await queryRunner.hasTable('global_ui_packages');
          const hasFileTable = await queryRunner.hasTable('global_ui_package_files');
          const hasDraftVersion =
            hasGlobalTable && (await queryRunner.hasColumn('global_ui_packages', 'draft_version'));
          if (!hasGlobalTable || !hasFileTable || !hasDraftVersion) {
            await CoreGlobalDataSource.synchronize();
          }
        } finally {
          await queryRunner.release();
        }
      }
      return CoreGlobalDataSource;
    })
    .catch((err) => {
      initPromise = null;
      throw err;
    });
  return initPromise;
};

export const resolveGlobalDataSource = async (fallback: DataSource) => {
  if (!hasCoreEnv()) return fallback;
  try {
    return await getCoreGlobalDataSource();
  } catch (err) {
    if (!loggedError) {
      const message = (err as Error)?.message || 'Unknown error';
      console.warn(`Global package DB unavailable, falling back to app DB: ${message}`);
      loggedError = true;
    }
    return fallback;
  }
};
