import vm from 'vm';
import { AppError } from '../common/AppError';
import type { SandboxAdapters } from './AdapterFactory';
import type { SandboxRequestContext, SandboxResult } from './sandboxTypes';

export const sanitizeRequest = (request: SandboxRequestContext): SandboxRequestContext => ({
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
});

export const resolveHandler = (exported: unknown): unknown => {
  if (typeof exported === 'function') {
    return exported;
  }
  if (exported && typeof exported === 'object' && (exported as Record<string, unknown>).default) {
    return (exported as Record<string, unknown>).default;
  }
  return null;
};

export const normalizeSandboxResult = (result: unknown): SandboxResult => {
  if (result && typeof result === 'object') {
    const typed = result as SandboxResult;
    return {
      statusCode: typed.statusCode ?? 200,
      headers: typed.headers,
      body: typed.body,
    };
  }
  return { statusCode: 200, body: result };
};

export const executeSandboxModule = async (
  code: string,
  request: SandboxRequestContext,
  adapters: SandboxAdapters,
  timeoutMs: number,
): Promise<SandboxResult> => {
  const frozenRequest = Object.freeze(sanitizeRequest(request)) as SandboxRequestContext;
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
      ${code}
      module.exports;
    `,
    { filename: 'tenant-module.js' },
  );

  let exported: unknown;
  try {
    exported = script.runInContext(vmContext, { timeout: timeoutMs });
  } catch (error) {
    throw new AppError(`Sandbox execution failed: ${(error as Error).message}`, 500);
  }

  const handler = resolveHandler(exported);
  if (typeof handler !== 'function') {
    throw new AppError('Module must export a function', 400);
  }

  try {
    const result = await Promise.race([
      Promise.resolve(handler(frozenRequest, adapters)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Execution timed out')), timeoutMs),
      ),
    ]);
    return normalizeSandboxResult(result);
  } catch (error) {
    throw new AppError(`Module error: ${(error as Error).message}`, 500);
  }
};
