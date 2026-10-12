import path from 'path';
import fs from 'fs/promises';
import { build } from 'esbuild';

export const buildKernelSourceRuntime = async (coreDirectory: string): Promise<string> => {
  const root = path.resolve(coreDirectory, '..');
  const candidates = [path.join(root, 'kernel/src/index.ts'), path.join(root, 'src/kernel/src/index.ts')];
  let entrypoint: string | undefined;
  for (const candidate of candidates) {
    try { await fs.access(candidate); entrypoint = candidate; break; } catch { /* Try the integration checkout path. */ }
  }
  if (!entrypoint) throw new Error('Kernel source file not found');
  // Source preview still has real local imports and npm dependencies. Bundle
  // them together so the browser receives no unresolved package specifiers.
  const output = await build({
    entryPoints: [entrypoint], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'RuntessaKernelSource',
    target: 'es2020', sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': '"development"' },
    footer: { js: 'window.Kernel = RuntessaKernelSource.Kernel; window.__IDP_KERNEL_BUILD__ = "dev-source";' },
  });
  const script = output.outputFiles?.find(file => file.path.endsWith('.js')) ?? output.outputFiles?.[0];
  if (!script?.text) throw new Error('Kernel source build produced no script');
  return script.text;
};
