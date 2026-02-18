import 'reflect-metadata';
import { parentPort } from 'worker_threads';
import { initializeDataSource } from '../core/datasource';
import { CryptoService } from '../core/security/CryptoService';
import { AdapterFactory } from './AdapterFactory';
import type { SandboxWorkerRunMessage } from './sandboxTypes';
import { executeSandboxModule } from './sandboxRuntime';

if (!parentPort) {
  process.exit(1);
}

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

parentPort.on('message', async (message: SandboxWorkerRunMessage) => {
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

    const result = await executeSandboxModule(
      message.code,
      message.request,
      adapters,
      message.timeoutMs,
    );

    parentPort?.postMessage({
      type: 'result',
      result,
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
