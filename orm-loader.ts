import vm from 'vm';
import path from 'path';
import { createRequire } from 'module';
import fs from 'fs';
import * as typeorm from 'typeorm';
import { OrmModel } from '@idp/shared';

const getNodeRequire = () => {
  const nonWebpack = (globalThis as any).__non_webpack_require__;
  if (typeof nonWebpack === 'function') return nonWebpack as (id: string) => any;
  if (typeof require === 'function') return require as (id: string) => any;
  return null;
};

const compileOrmSource = (source: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript') as typeof import('typescript');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        allowJs: true,
      },
      fileName: 'model.js',
    });
    const diagnostics = result.diagnostics ?? [];
    const errors = diagnostics.filter(
      (diag) => diag.category === ts.DiagnosticCategory.Error
    );
    if (errors.length) {
      const host: import('typescript').FormatDiagnosticsHost = {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      };
      const formatted = ts
        .formatDiagnosticsWithColorAndContext(errors, host)
        .replace(/\x1B\[[0-9;]*m/g, '');
      throw new Error(`Model compile error:\n${formatted}`);
    }
    return result.outputText || source;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Model compile error')) {
      throw err;
    }
    return source;
  }
};

const normalizePath = (value: string) => {
  const raw = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  const stack: string[] = [];
  parts.forEach((part) => {
    if (part === '.' || part === '') return;
    if (part === '..') {
      stack.pop();
      return;
    }
    stack.push(part);
  });
  return stack.join('/');
};

const ensureJsExtension = (value: string) => {
  if (!value) return '';
  const extMatch = value.match(/\.([^.\/]+)$/);
  if (!extMatch) return `${value}.js`;
  const ext = extMatch[1]?.toLowerCase();
  if (ext !== 'js') {
    return value.replace(/\.[^.\/]+$/, '.js');
  }
  return value;
};

const EXTENSIONS = ['.js'];

const findKeyInsensitive = (value: string, moduleMap: Map<string, string>) => {
  const target = value.toLowerCase();
  for (const key of moduleMap.keys()) {
    if (key.toLowerCase() === target) return key;
  }
  return null;
};

const findByBasename = (name: string, moduleMap: Map<string, string>) => {
  if (!name) return null;
  const baseName = name.split('/').pop() || name;
  const baseNoExt = baseName.replace(/\.[^.]+$/, '');
  const matches: string[] = [];
  for (const key of moduleMap.keys()) {
    const keyBase = key.split('/').pop() || key;
    const keyBaseNoExt = keyBase.replace(/\.[^.]+$/, '');
    if (
      keyBase === baseName ||
      keyBaseNoExt === baseNoExt ||
      keyBase.toLowerCase() === baseName.toLowerCase() ||
      keyBaseNoExt.toLowerCase() === baseNoExt.toLowerCase()
    ) {
      matches.push(key);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exact = matches.find((key) => (key.split('/').pop() || key) === baseName);
    return exact ?? matches[0];
  }
  return null;
};

const resolveModule = (request: string, from: string, moduleMap: Map<string, string>) => {
  const raw = String(request || '').trim();
  if (!raw) return '';
  const normalizedBare = normalizePath(raw);
  const resolveBare = () => {
    if (!normalizedBare) return null;
    if (moduleMap.has(normalizedBare)) return normalizedBare;
    const insensitive = findKeyInsensitive(normalizedBare, moduleMap);
    if (insensitive) return insensitive;
    for (const ext of EXTENSIONS) {
      if (moduleMap.has(normalizedBare + ext)) return normalizedBare + ext;
      const insensitiveExt = findKeyInsensitive(normalizedBare + ext, moduleMap);
      if (insensitiveExt) return insensitiveExt;
    }
    const baseNoExt = normalizedBare.replace(/\.[^.]+$/, '');
    if (baseNoExt && baseNoExt !== normalizedBare) {
      for (const ext of EXTENSIONS) {
        if (moduleMap.has(baseNoExt + ext)) return baseNoExt + ext;
        const insensitiveBase = findKeyInsensitive(baseNoExt + ext, moduleMap);
        if (insensitiveBase) return insensitiveBase;
      }
    }
    const byBasename = findByBasename(normalizedBare, moduleMap);
    if (byBasename) return byBasename;
    return null;
  };
  if (!raw.startsWith('.') && !raw.startsWith('/')) {
    const resolvedBare = resolveBare();
    return resolvedBare ?? raw;
  }
  const baseParts = from ? normalizePath(from).split('/').slice(0, -1) : [];
  const targetParts = raw.startsWith('/') ? raw.split('/') : baseParts.concat(raw.split('/'));
  const normalized = normalizePath(targetParts.join('/'));
  if (moduleMap.has(normalized)) return normalized;
  const insensitive = findKeyInsensitive(normalized, moduleMap);
  if (insensitive) return insensitive;
  for (const ext of EXTENSIONS) {
    if (moduleMap.has(normalized + ext)) return normalized + ext;
    const insensitiveExt = findKeyInsensitive(normalized + ext, moduleMap);
    if (insensitiveExt) return insensitiveExt;
  }
  const normalizedNoExt = normalized.replace(/\.[^.]+$/, '');
  if (normalizedNoExt && normalizedNoExt !== normalized) {
    for (const ext of EXTENSIONS) {
      if (moduleMap.has(normalizedNoExt + ext)) return normalizedNoExt + ext;
      const insensitiveNoExt = findKeyInsensitive(normalizedNoExt + ext, moduleMap);
      if (insensitiveNoExt) return insensitiveNoExt;
    }
  }
  const fallback = findByBasename(normalized, moduleMap);
  if (fallback) return fallback;
  return normalized;
};

export const loadOrmEntitiesFromModels = (models: OrmModel[]) => {
  try {
    // Ensure reflect-metadata is loaded before evaluating entity decorators
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('reflect-metadata');
  } catch {
    // ignore
  }

  const rootRequire = (() => {
    const candidates: Array<(id: string) => any> = [];
    const nodeRequire = getNodeRequire();
    if (nodeRequire) {
      candidates.push((id: string) => nodeRequire(id));
    }
    const cwd = process.cwd();
    const roots = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '../..')];
    roots.forEach((root) => {
      try {
        const pkgPath = path.join(root, 'package.json');
        const req = createRequire(fs.existsSync(pkgPath) ? pkgPath : root + path.sep);
        candidates.push((id: string) => req(id));
      } catch {
        // ignore
      }
    });
    return (id: string) => {
      if (id === 'typeorm' || id.startsWith('typeorm/')) {
        return typeorm;
      }
      for (const candidate of candidates) {
        try {
          return candidate(id);
        } catch {
          // try next candidate
        }
      }
      throw new Error(`External require not available: ${id}`);
    };
  })();

  const moduleMap = new Map<string, string>();
  models.forEach((model) => {
    const normalized = ensureJsExtension(normalizePath(model.path));
    if (!normalized) return;
    const rawSource = model.codeBlob || model.code || '';
    const source = model.codeBlob ? rawSource : compileOrmSource(rawSource);
    moduleMap.set(normalized, source);
    const baseName = normalized.split('/').pop() || '';
    if (baseName && !moduleMap.has(baseName)) {
      moduleMap.set(baseName, source);
    }
    const baseNoExt = baseName.replace(/\.[^.]+$/, '');
    if (baseNoExt && !moduleMap.has(baseNoExt)) {
      moduleMap.set(baseNoExt, source);
    }
  });

  const cache = new Map<string, any>();

  const localRequire = (request: string, from: string) => {
    const normalizedRequest = String(request || '').replace(/\0/g, '').trim();
    const lowered = normalizedRequest.toLowerCase();
    if (lowered === 'typeorm' || lowered.startsWith('typeorm/')) {
      return typeorm;
    }
    let resolved = resolveModule(normalizedRequest, from, moduleMap);
    if (!moduleMap.has(resolved)) {
      const fallback =
        findByBasename(normalizedRequest, moduleMap) ||
        findKeyInsensitive(normalizedRequest, moduleMap);
      if (fallback) {
        resolved = fallback;
      }
    }
    const isBare =
      !normalizedRequest.startsWith('.') && !normalizedRequest.startsWith('/');
    const isScoped = normalizedRequest.startsWith('@');
    const looksLikeFile =
      normalizedRequest.endsWith('.js') || normalizedRequest.includes('/');
    if (isBare && !moduleMap.has(resolved)) {
      if (isScoped || (!looksLikeFile && !normalizedRequest.includes('.'))) {
        return rootRequire(normalizedRequest);
      }
      throw new Error(`Cannot find module ${normalizedRequest}`);
    }
    if (!moduleMap.has(resolved)) {
      throw new Error(`Cannot find module ${normalizedRequest}`);
    }
    if (cache.has(resolved)) return cache.get(resolved);
    const code = moduleMap.get(resolved) || '';
    const module = { exports: {} as any };
    const dirname = path.posix.dirname(resolved);
    const wrapper = `(function (module, exports, require, __filename, __dirname) { "use strict";\n${code}\n})`;
    const script = new vm.Script(wrapper, { filename: resolved });
    const fn = script.runInThisContext();
    fn(module, module.exports, (id: string) => localRequire(id, resolved), resolved, dirname);
    cache.set(resolved, module.exports);
    return module.exports;
  };

  const exportsList: any[] = [];
  models.forEach((model) => {
    const normalized = ensureJsExtension(normalizePath(model.path));
    if (!normalized) return;
    try {
      exportsList.push(localRequire(`./${normalized}`, ''));
    } catch {
      exportsList.push(localRequire(normalized, ''));
    }
  });

  const getMetadataStorage = () => {
    if (typeof (typeorm as any)?.getMetadataArgsStorage === 'function') {
      return (typeorm as any).getMetadataArgsStorage();
    }
    return null;
  };
  const metadataStorage = getMetadataStorage();
  const metadataTargets = new Set(
    (metadataStorage?.tables ?? []).map((table: { target: any }) => table.target)
  );
  const entities: any[] = [];
  const entityMap: Record<string, any> = {};
  let matched = 0;

  const pushEntity = (key: string, value: any) => {
    if (typeof value !== 'function') return;
    if (entities.includes(value)) return;
    entities.push(value);
    entityMap[key] = value;
    if (value.name && !entityMap[value.name]) {
      entityMap[value.name] = value;
    }
  };

  exportsList.forEach((exports) => {
    if (!exports) return;
    if (typeof exports === 'function') {
      if (metadataTargets.has(exports)) {
        pushEntity(exports.name || 'Entity', exports);
        matched += 1;
      }
      return;
    }
    if (typeof exports !== 'object') return;
    Object.entries(exports).forEach(([key, value]) => {
      if (typeof value !== 'function') return;
      if (metadataTargets.has(value)) {
        pushEntity(key, value);
        matched += 1;
      }
    });
  });

  if (matched === 0) {
    exportsList.forEach((exports) => {
      if (!exports) return;
      if (typeof exports === 'function') {
        pushEntity(exports.name || 'Entity', exports);
        return;
      }
      if (typeof exports !== 'object') return;
      Object.entries(exports).forEach(([key, value]) => {
        if (typeof value !== 'function') return;
        pushEntity(key, value);
      });
    });
  }

  return { entities, entityMap };
};
