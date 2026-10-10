import { SandboxRunner } from './SandboxRunner';
import type { SandboxContext, SandboxResult } from './sandboxTypes';

// Compatibility entry point; all execution uses the restricted process.
export const runSandboxInWorker = (code: string, context: SandboxContext, timeoutMs: number, memoryMb: number): Promise<SandboxResult> =>
  new SandboxRunner(timeoutMs, memoryMb).run(code, context);
