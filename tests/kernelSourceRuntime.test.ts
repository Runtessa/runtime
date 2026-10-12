import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { buildKernelSourceRuntime } from '../app/kernelSourceRuntime';

(async () => {
  const source = await buildKernelSourceRuntime(path.resolve(__dirname, '..'));
  assert(!/^\s*import\s/m.test(source), 'Browser source must include local and package imports');
  const context = { window: {} as any, console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder };
  vm.runInNewContext(source, context, { timeout: 10000 });
  assert.equal(typeof context.window.Kernel, 'function');
  assert.equal(context.window.__IDP_KERNEL_BUILD__, 'dev-source');
  console.log('Development Kernel source loads with local helpers and router dependencies bundled.');
})().catch(error => { console.error(error); process.exitCode = 1; });
