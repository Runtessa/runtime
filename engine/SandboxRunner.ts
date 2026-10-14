import path from 'path';
import fs from 'fs';
import { runtimeDependencyRoots, runRestrictedProcess } from '@idp/shared/dist/runtime/restricted-process';
import { sanitizeRequest } from './sandboxRuntime';
import { AppError } from '../common/AppError';
import type {
  SandboxContext,
  SandboxRequestContext,
  SandboxResult,
} from './sandboxTypes';

export type { SandboxContext, SandboxRequestContext, SandboxResult } from './sandboxTypes';

export class SandboxRunner {
  constructor(private readonly maxTimeoutMs = 30_000, private readonly maxMemoryMb = 2048) {}

  async run(code: string, context: SandboxContext): Promise<SandboxResult> {
    const safeRequest = sanitizeRequest(context.request);
    const effectiveTimeout = this.resolveTimeout(safeRequest.tenant.resourceConfig);
    const effectiveMemory = this.resolveMemory(safeRequest.tenant.resourceConfig);

    if (!context.tenant) throw new Error('Tenant is required for restricted execution');
    const localEntry = path.join(__dirname, 'sandboxProcess.js');
    const entrypoint = fs.existsSync(localEntry) ? localEntry : path.resolve(__dirname, '../../../dist/engine/sandboxProcess.js');
    try {
      return await runRestrictedProcess<SandboxResult>({
        entrypoint,
        readOnlyRoots: [...runtimeDependencyRoots(), path.resolve(path.dirname(entrypoint), '..')],
        input: {
          code, request: safeRequest,
          // Only the policy needed for the child API. Other tenant settings stay in the parent.
          tenant: { id: context.tenant.id, hostname: context.tenant.hostname, adapterAccess: context.tenant.adapterAccess },
          allowDraftSharedModules: Boolean(context.allowDraftSharedModules), timeoutMs: effectiveTimeout,
        },
        timeoutMs: effectiveTimeout, memoryMb: effectiveMemory, call: context.capabilities, allowPublicHttp: true,
      });
    } catch (error) {
      const failure = error as Error & { statusCode?: number };
      const status = Number(failure.statusCode);
      throw new AppError(failure.message || 'Restricted runtime failed',
        Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);
    } finally {
      await context.capabilities?.dispose?.();
    }
  }

  private resolveTimeout(resourceConfig: { memory: number; timeout: number }): number {
    const configured = resourceConfig?.timeout ?? 5_000;
    return Number.isFinite(configured) && configured > 0
      ? Math.max(1, Math.min(configured, this.maxTimeoutMs, 30000))
      : Math.min(5000, this.maxTimeoutMs);
  }

  private resolveMemory(resourceConfig: { memory: number; timeout: number }): number {
    const configured = resourceConfig?.memory ?? 512;
    if (!Number.isFinite(configured) || configured <= 0) {
      return Math.min(512, this.maxMemoryMb);
    }
    return Math.max(32, Math.floor(Math.min(configured, this.maxMemoryMb, 2048)));
  }
}
