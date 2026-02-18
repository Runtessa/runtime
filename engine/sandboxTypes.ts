import { Tenant } from '@idp/shared';
import type { SandboxAdapters } from './AdapterFactory';

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
    role: string;
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

export interface SandboxWorkerRunMessage {
  type: 'run';
  code: string;
  request: SandboxRequestContext;
  tenant: Tenant;
  allowDraftSharedModules?: boolean;
  timeoutMs: number;
}

export interface SandboxWorkerResultMessage {
  type: 'result';
  result: SandboxResult;
}

export interface SandboxWorkerErrorMessage {
  type: 'error';
  message?: string;
  statusCode?: number;
}
