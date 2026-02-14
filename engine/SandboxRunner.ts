import vm from 'vm';
import path from 'path';
import { Worker } from 'worker_threads';
import { SandboxAdapters } from './AdapterFactory';
import { AccountRole, Tenant } from '@idp/shared';
import { AppError } from '../common/AppError';

export interface SandboxRequestContext {
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
}

export interface SandboxContext {
  request: SandboxRequestContext;
  adapters: SandboxAdapters;
  tenant?: Tenant;
  allowDraftSharedModules?: boolean;
}

export interface SandboxResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export class SandboxRunner {
  constructor(private readonly maxTimeoutMs = 30_000, private readonly maxMemoryMb = 2048) {}

  async run(code: string, context: SandboxContext): Promise<SandboxResult> {
    const safeRequest = this.sanitizeRequest(context.request);
    const effectiveTimeout = this.resolveTimeout(safeRequest.tenant.resourceConfig);
    const effectiveMemory = this.resolveMemory(safeRequest.tenant.resourceConfig);

    if (effectiveMemory && context.tenant) {
      return this.runInWorker(code, { ...context, request: safeRequest }, effectiveTimeout, effectiveMemory);
    }

    const frozenAdapters: SandboxAdapters = context.adapters;
    const frozenRequest = Object.freeze({ ...safeRequest }) as SandboxRequestContext;

    const sandboxGlobals: Record<string, unknown> = {
      request: frozenRequest,
      adapters: frozenAdapters,
      console,
    };
    Object.freeze(sandboxGlobals);

    const vmContext = vm.createContext(sandboxGlobals);
    const script = new vm.Script(
      `
        "use strict";
        const module = { exports: {} };
        const exports = module.exports;
        ${code}
        module.exports;
      `,
      { filename: 'tenant-module.js' },
    );

    let exported: unknown;
    try {
      exported = script.runInContext(vmContext, { timeout: effectiveTimeout });
    } catch (error) {
      throw new AppError(`Sandbox execution failed: ${(error as Error).message}`, 500);
    }

    const handler = this.resolveHandler(exported);
    if (typeof handler !== 'function') {
      throw new AppError('Module must export a function', 400);
    }

    try {
      const result = await Promise.race([
        Promise.resolve(handler(frozenRequest, frozenAdapters)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Execution timed out')), effectiveTimeout),
        ),
      ]);

      if (result && typeof result === 'object') {
        const typed = result as SandboxResult;
        return {
          statusCode: typed.statusCode ?? 200,
          headers: typed.headers,
          body: typed.body,
        };
      }

      return { statusCode: 200, body: result };
    } catch (error) {
      throw new AppError(`Module error: ${(error as Error).message}`, 500);
    }
  }

  private resolveHandler(exported: unknown): unknown {
    if (typeof exported === 'function') {
      return exported;
    }

    if (exported && typeof exported === 'object' && (exported as Record<string, unknown>).default) {
      return (exported as Record<string, unknown>).default;
    }

    return null;
  }

  private sanitizeRequest(request: SandboxRequestContext): SandboxRequestContext {
    return {
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
        ? {
            id: request.account.id,
            email: request.account.email,
            role: request.account.role,
          }
        : undefined,
    };
  }

  private resolveTimeout(resourceConfig: { memory: number; timeout: number }): number {
    const configured = resourceConfig?.timeout ?? 5_000;
    return Math.min(configured, this.maxTimeoutMs);
  }

  private resolveMemory(resourceConfig: { memory: number; timeout: number }): number {
    const configured = resourceConfig?.memory ?? 512;
    if (!Number.isFinite(configured) || configured <= 0) {
      return 0;
    }
    return Math.min(configured, this.maxMemoryMb);
  }

  private runInWorker(
    code: string,
    context: SandboxContext,
    timeoutMs: number,
    memoryMb: number,
  ): Promise<SandboxResult> {
    const workerPath = path.join(__dirname, 'sandboxWorker.js');
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: memoryMb },
      });

      const cleanup = () => {
        worker.removeAllListeners();
      };

      const timeout = setTimeout(() => {
        worker.terminate().finally(() => {
          cleanup();
          reject(new AppError('Execution timed out', 500));
        });
      }, timeoutMs + 50);

      worker.on('message', (message) => {
        if (message?.type === 'result') {
          clearTimeout(timeout);
          cleanup();
          worker.terminate().finally(() => resolve(message.result as SandboxResult));
        } else if (message?.type === 'error') {
          clearTimeout(timeout);
          cleanup();
          worker.terminate().finally(() => {
            const status = Number(message.statusCode) || 500;
            reject(new AppError(message.message || 'Sandbox failed', status));
          });
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        cleanup();
        worker.terminate().finally(() => reject(new AppError(err.message, 500)));
      });

      worker.postMessage({
        type: 'run',
        code,
        request: context.request,
        tenant: context.tenant,
        allowDraftSharedModules: context.allowDraftSharedModules ?? false,
        timeoutMs,
      });
    });
  }
}
