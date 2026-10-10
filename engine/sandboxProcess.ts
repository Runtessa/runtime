import 'reflect-metadata';
import { serveRestrictedProcess } from '@idp/shared/dist/runtime/process-channel';
import { executeSandboxModule } from './sandboxRuntime';
import { buildProcessAdapters } from './sandboxProcessAdapters';

serveRestrictedProcess(async (input, call) => {
  const adapters = buildProcessAdapters(input.tenant, input.allowDraftSharedModules, call);
  return executeSandboxModule(input.code, input.request, adapters, input.timeoutMs);
});
