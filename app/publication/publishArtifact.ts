import type { DataSource } from 'typeorm';
import { CompiledCode, ModuleEntity, SourceCode, UIPackage } from '@idp/shared';
import { AppError } from '../../common/AppError';
import { generateVersion } from '../../common/version';

export async function publishArtifact(source: DataSource, kind: 'module' | 'ui', tenantId: string, id: string) {
  return source.transaction(async (manager) => {
    const entity = kind === 'module' ? ModuleEntity : UIPackage;
    const repo = manager.getRepository(entity as typeof ModuleEntity);
    const where = { id, tenant: { id: tenantId } };
    if (!await repo.findOne({ where, lock: { mode: 'pessimistic_write' } })) throw new AppError('Publication item not found', 404);
    const record: any = await repo.findOne({ where, relations: ['sourceCode', ...(kind === 'ui' ? ['compiledCode'] : [])] });
    if (!record.sourceCode || (kind === 'ui' && !record.compiledCode)) throw new AppError('Build the source before publishing', 409);
    const revision = generateVersion(), publishedAt = new Date(), cacheKeys = new Set<string>();
    const snapshot = (row: any) => {
      row.publishedVersion = revision;
      row.publishedSourceCode = manager.getRepository(SourceCode).create({ code: row.code });
      row.publishedFileExtension = row.fileExtension;
      row.publishedAt = publishedAt;
      if (kind === 'ui') {
        row.publishedCompiledCode = manager.getRepository(CompiledCode).create({ code: row.codeBlob });
        row.publishedDependencies = row.dependencies ?? [];
        for (const version of ['latest', row.version]) cacheKeys.add(`registry:tenant:${tenantId}:${encodeURIComponent(row.name)}:${version}`);
      }
    };
    if (kind === 'module') {
      for (const method of [record.publishedMethod ?? record.method, record.method]) cacheKeys.add(`module:published:${tenantId}:${method}`);
      record.publishedRoutePath = record.routePath;
      record.publishedMethod = record.method;
    }
    snapshot(record);
    await repo.save(record);
    if (kind === 'ui' && !record.name.endsWith('__tw')) {
      const styles = manager.getRepository(UIPackage);
      const styleWhere = { tenant: { id: tenantId }, name: `${record.name}__tw`, version: record.version };
      const locked = await styles.findOne({ where: styleWhere, lock: { mode: 'pessimistic_write' } });
      if (locked) {
        const css = (await styles.findOne({ where: styleWhere, relations: ['sourceCode', 'compiledCode'] }))!;
        if (!css.sourceCode || !css.compiledCode) throw new AppError('Build the stylesheet before publishing', 409);
        snapshot(css); await styles.save(css);
      } else if (record.dependencies?.includes(styleWhere.name)) throw new AppError('Required stylesheet is missing', 409);
    }
    return { record, cacheKeys };
  });
}
