import 'reflect-metadata';
import vm from 'vm';
import { parentPort } from 'worker_threads';
import { AppError } from '../common/AppError';
import { initializeDataSource } from '../core/datasource';
import { CryptoService } from '../core/security/CryptoService';
import { AdapterFactory } from './AdapterFactory';
import { AccountRole, Tenant } from '@idp/shared';

if (!parentPort) {
  process.exit(1);
}

type SandboxRequestContext = {
  path: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  params: Record<string, string>;
  tenant: {
    id: string;
    hostname: string;
    resourceConfig: {
      memory: number;
      timeout: number;
    };
  };
  account?: {
    id: string;
    email: string;
    role: AccountRole;
  };
};

type WorkerMessage = {
  type: 'run';
  code: string;
  request: SandboxRequestContext;
  tenant: Tenant;
  allowDraftSharedModules?: boolean;
  timeoutMs: number;
};

const getKeyFromEnv = (envName: string, expectedBytes: number): Buffer => {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`${envName} is required`);
  }
  const isHex = /^[a-fA-F0-9]+$/.test(raw) && raw.length === expectedBytes * 2;
  const buffer = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buffer.length !== expectedBytes) {
    throw new Error(`${envName} must decode to ${expectedBytes} bytes`);
  }
  return buffer;
};

const resolveHandler = (exported: unknown) => {
  if (typeof exported === 'function') {
    return exported;
  }
  if (exported && typeof exported === 'object' && (exported as Record<string, unknown>).default) {
    return (exported as Record<string, unknown>).default;
  }
  return null;
};

const sanitizeRequest = (request: SandboxRequestContext): SandboxRequestContext => ({
  path: request.path,
  method: request.method,
  headers: { ...request.headers },
  query: { ...request.query },
  body: request.body,
  params: { ...(request.params ?? {}) },
  tenant: {
    id: request.tenant.id,
    hostname: request.tenant.hostname,
    resourceConfig: { ...request.tenant.resourceConfig },
  },
  account: request.account
    ? { id: request.account.id, email: request.account.email, role: request.account.role }
    : undefined,
});

parentPort.on('message', async (message: WorkerMessage) => {
  if (!message || message.type !== 'run') return;

  try {
    const dataSource = await initializeDataSource();
    const cryptoService = new CryptoService(
      getKeyFromEnv('ENCRYPTION_KEY', 32),
      getKeyFromEnv('TOKEN_SECRET', 32),
    );
    const adapterFactory = new AdapterFactory(dataSource, cryptoService);
    const adapters = await adapterFactory.build(message.tenant, {
      allowDraftSharedModules: message.allowDraftSharedModules ?? false,
    });

    const frozenRequest = Object.freeze(sanitizeRequest(message.request));
    const sandboxGlobals: Record<string, unknown> = {
      request: frozenRequest,
      adapters,
      console,
    };
    Object.freeze(sandboxGlobals);

    const vmContext = vm.createContext(sandboxGlobals);
    const script = new vm.Script(
      `
        "use strict";
        const module = { exports: {} };
        const exports = module.exports;
        ${message.code}
        module.exports;
      `,
      { filename: 'tenant-module.js' },
    );

    let exported: unknown;
    try {
      exported = script.runInContext(vmContext, { timeout: message.timeoutMs });
    } catch (error) {
      throw new AppError(`Sandbox execution failed: ${(error as Error).message}`, 500);
    }

    const handler = resolveHandler(exported);
    if (typeof handler !== 'function') {
      throw new AppError('Module must export a function', 400);
    }

    const result = await Promise.race([
      Promise.resolve(handler(frozenRequest, adapters)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Execution timed out')), message.timeoutMs),
      ),
    ]);

    if (result && typeof result === 'object') {
      const typed = result as { statusCode?: number; headers?: Record<string, string>; body?: unknown };
      parentPort?.postMessage({
        type: 'result',
        result: {
          statusCode: typed.statusCode ?? 200,
          headers: typed.headers,
          body: typed.body,
        },
      });
      return;
    }

    parentPort?.postMessage({
      type: 'result',
      result: { statusCode: 200, body: result },
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    parentPort?.postMessage({
      type: 'error',
      message: err.message || 'Sandbox failed',
      statusCode: err.statusCode ?? 500,
    });
  }
});
