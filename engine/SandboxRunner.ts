import { executeSandboxModule, sanitizeRequest } from './sandboxRuntime';
import { runSandboxInWorker } from './sandboxWorkerClient';
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

    if (effectiveMemory && context.tenant) {
      return runSandboxInWorker(
        code,
        { ...context, request: safeRequest },
        effectiveTimeout,
        effectiveMemory,
      );
    }
    return executeSandboxModule(code, safeRequest, context.adapters, effectiveTimeout);
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
}
