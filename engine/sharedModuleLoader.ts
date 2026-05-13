import { DataSource } from 'typeorm';
import vm from 'vm';
import { GlobalModulePackage } from '@idp/shared';
import { resolveGlobalDataSource } from '../core/globalDatasource';

export class SharedModuleLoader {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cache: Map<string, unknown>,
  ) {}

  async load(name: string, version?: string, allowDraft = false): Promise<unknown> {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('Shared module name is required');
    }
    const versionToken = String(version || 'latest').trim() || 'latest';

    const globalDataSource = await resolveGlobalDataSource(this.dataSource);
    const repo = globalDataSource.getRepository(GlobalModulePackage);
    let pkg: GlobalModulePackage | null = null;

    if (versionToken === 'latest') {
      const latest = await repo.find({
        where: { name: normalizedName },
        relations: ['compiledCode', 'publishedCompiledCode'],
        order: { createdAt: 'DESC' },
        take: 1,
      });
      pkg = latest[0] ?? null;
    } else {
      pkg = await repo.findOne({
        where: { name: normalizedName, version: versionToken },
        relations: ['compiledCode', 'publishedCompiledCode'],
      });
    }

    if (!pkg) {
      throw new Error(`Shared module ${normalizedName}@${versionToken} not found`);
    }

    const resolvedVersion = allowDraft
      ? pkg.draftVersion || pkg.version
      : pkg.publishedVersion || pkg.version;
    const cacheKey = `${normalizedName}@${versionToken === 'latest' ? resolvedVersion : versionToken}:${
      allowDraft ? 'draft' : 'published'
    }`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const source = allowDraft ? pkg.compiledCode?.code : pkg.publishedCompiledCode?.code;
    if (!source) {
      if (allowDraft) {
        throw new Error(`Shared module ${normalizedName}@${versionToken} has no draft code`);
      }
      throw new Error(`Shared module ${normalizedName}@${versionToken} is not published`);
    }

    const exports = this.evaluate(source, normalizedName);
    this.cache.set(cacheKey, exports);
    return exports;
  }

  private evaluate(source: string, name: string): unknown {
    const module = { exports: {} as unknown };
    const sandboxGlobals: Record<string, unknown> = {
      module,
      exports: module.exports,
      require: (id: string) => {
        throw new Error(`External require not allowed: ${id}`);
      },
      console,
    };
    const context = vm.createContext(sandboxGlobals);
    const script = new vm.Script(`"use strict";\n${source}`, {
      filename: `shared-module:${name}`,
    });
    script.runInContext(context);
    return module.exports;
  }
}
