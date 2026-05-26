import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { build } from 'esbuild';
import { publishedCache } from '../../core/publishedCache';

const execFileAsync = promisify(execFile);
const CACHE_TTL_SECONDS = 30 * 60;
const memoryCache = new Map<string, NpmRegistryPayload>();
const inFlight = new Map<string, Promise<NpmRegistryPayload | null>>();
const EXTERNALS = ['react', 'react-dom', 'react-dom/client'];

const cacheKey = (name: string, version: string) =>
  `registry:npm:v2:${encodeURIComponent(name)}:${encodeURIComponent(version)}`;

const isBlockedName = (name: string) =>
  name.startsWith('@app/') || name.startsWith('@idp/') || name.startsWith('idp/') || name.startsWith('@shared/');

const normalizeVersionToken = (value?: string) => {
  const token = (value || 'latest').trim();
  return token || 'latest';
};

const parseRequestSpecifier = (
  request: string
): { installName: string; requestSpecifier: string; runtimeSpecifier: string } | null => {
  const normalized = String(request || '').trim();
  if (!normalized) return null;
  if (normalized.startsWith('.') || normalized.startsWith('/')) return null;
  if (
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.includes('..') ||
    normalized.includes('?') ||
    normalized.includes('#')
  ) {
    return null;
  }

  if (normalized === 'react-router/dom') {
    return {
      installName: 'react-router-dom',
      requestSpecifier: normalized,
      runtimeSpecifier: 'react-router-dom',
    };
  }

  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (normalized.startsWith('@')) {
    if (parts.length < 2) return null;
    const scope = parts[0];
    const pkg = parts[1];
    if (!/^@[a-z0-9][a-z0-9._-]*$/i.test(scope)) return null;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return null;
    return {
      installName: `${scope}/${pkg}`,
      requestSpecifier: normalized,
      runtimeSpecifier: normalized,
    };
  }
  const pkg = parts[0];
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return null;
  return {
    installName: pkg,
    requestSpecifier: normalized,
    runtimeSpecifier: normalized,
  };
};

const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
};

const resolvePackageJsonPath = (workDir: string, packageName: string) =>
  path.join(workDir, 'node_modules', ...packageName.split('/'), 'package.json');

const runNpmInstall = async (workDir: string, spec: string) => {
  await execFileAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--no-package-lock',
      spec,
    ],
    {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production' },
    }
  );
};

const bundleInstalledPackage = async (workDir: string, requestSpecifier: string) => {
  const entryPath = path.join(workDir, '__idp_npm_entry__.js');
  await fs.writeFile(
    entryPath,
    `module.exports = require(${JSON.stringify(requestSpecifier)});\n`,
    'utf8'
  );
  const result = await build({
    absWorkingDir: workDir,
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['es2019'],
    external: EXTERNALS,
    logLevel: 'silent',
    mainFields: ['browser', 'module', 'main'],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      global: 'globalThis',
    },
    loader: {
      '.css': 'text',
      '.svg': 'text',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
    },
  });
  const bundled = result.outputFiles?.[0]?.text;
  if (!bundled) {
    throw new Error(`Failed to bundle npm package ${requestSpecifier}`);
  }
  return bundled;
};

const cleanupDir = async (dir: string) => {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup errors
  }
};

const buildNpmPayload = async (request: string, versionToken: string): Promise<NpmRegistryPayload> => {
  const parsed = parseRequestSpecifier(request);
  if (!parsed) {
    throw new Error(`Invalid npm specifier: ${request}`);
  }
  const { installName, requestSpecifier, runtimeSpecifier } = parsed;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-npm-ui-'));
  try {
    await fs.writeFile(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({
        name: 'idp-npm-build',
        private: true,
      }),
      'utf8'
    );

    await runNpmInstall(tempRoot, `${installName}@${versionToken}`);
    const bundleSource = await bundleInstalledPackage(tempRoot, runtimeSpecifier);
    const pkgJsonPath = resolvePackageJsonPath(tempRoot, installName);
    const pkgJson = await readJsonFile<{ version?: string }>(pkgJsonPath);
    const resolvedVersion = (pkgJson.version || versionToken).trim() || versionToken;

    return {
      name: requestSpecifier,
      version: resolvedVersion,
      source: bundleSource,
      dependencies: [],
      fileExtension: 'js',
    };
  } finally {
    await cleanupDir(tempRoot);
  }
};

export type NpmRegistryPayload = {
  name: string;
  version: string;
  source: string;
  dependencies: string[];
  fileExtension: string;
};

export const resolveNpmRegistryPackage = async (
  name: string,
  version?: string
): Promise<NpmRegistryPayload | null> => {
  const normalizedName = String(name || '').trim();
  const versionToken = normalizeVersionToken(version);
  const parsed = parseRequestSpecifier(normalizedName);
  if (!parsed) return null;
  const { installName } = parsed;
  if (isBlockedName(normalizedName)) return null;
  if (isBlockedName(installName)) return null;

  const key = cacheKey(normalizedName, versionToken);
  const cachedMemory = memoryCache.get(key);
  if (cachedMemory) return cachedMemory;

  const cachedDistributed = await publishedCache.get<NpmRegistryPayload>(key);
  if (cachedDistributed?.source) {
    memoryCache.set(key, cachedDistributed);
    return cachedDistributed;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const payload = await buildNpmPayload(normalizedName, versionToken);
      memoryCache.set(key, payload);
      await publishedCache.set(key, payload, CACHE_TTL_SECONDS);
      const exactKey = cacheKey(normalizedName, payload.version);
      memoryCache.set(exactKey, payload);
      await publishedCache.set(exactKey, payload, CACHE_TTL_SECONDS);
      return payload;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
};
