import path from 'path';
import { Worker } from 'worker_threads';
import fs from 'fs';
import { AppError } from '../common/AppError';
import type {
  SandboxContext,
  SandboxResult,
  SandboxWorkerErrorMessage,
  SandboxWorkerResultMessage,
} from './sandboxTypes';

const resolveWorkerEntrypoint = (): { workerPath: string; execArgv?: string[] } => {
  const jsWorkerPath = path.join(__dirname, 'sandboxWorker.js');
  const tsWorkerPath = path.join(__dirname, 'sandboxWorker.ts');

  if (fs.existsSync(jsWorkerPath)) {
    return { workerPath: jsWorkerPath };
  }
  if (fs.existsSync(tsWorkerPath)) {
    return {
      workerPath: tsWorkerPath,
      execArgv: ['-r', 'ts-node/register/transpile-only'],
    };
  }

  throw new AppError(
    `Sandbox worker entry not found. Tried: ${jsWorkerPath}, ${tsWorkerPath}`,
    500,
  );
};

export const runSandboxInWorker = (
  code: string,
  context: SandboxContext,
  timeoutMs: number,
  memoryMb: number,
): Promise<SandboxResult> => {
  const { workerPath, execArgv } = resolveWorkerEntrypoint();

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
      ...(execArgv ? { execArgv } : {}),
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

    worker.on('message', (message: SandboxWorkerResultMessage | SandboxWorkerErrorMessage) => {
      if (message?.type === 'result') {
        clearTimeout(timeout);
        cleanup();
        worker.terminate().finally(() => resolve(message.result));
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
};
