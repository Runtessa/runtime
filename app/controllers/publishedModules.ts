import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import { HttpMethod, ModuleEntity } from '@idp/shared';
import { publishedCache } from '../../core/publishedCache';
import { publishedModulesCacheKey } from './dispatcherPath';

type PublishedModule = { routePath: string; method: HttpMethod; code: string; fileExtension?: string };
const revisionKey = (tenantId: string, method: HttpMethod, rows: ModuleEntity[]) => {
  const revision = rows.filter((row) => row.publishedVersion).map((row) => `${row.id}:${row.publishedVersion}`).sort();
  return `${publishedModulesCacheKey(tenantId, method)}:${createHash('sha256').update(JSON.stringify(revision)).digest('hex')}`;
};

export async function loadPublishedModules(repo: Repository<ModuleEntity>, tenantId: string, method: HttpMethod): Promise<PublishedModule[]> {
  // The database revision is authoritative; cache invalidation is only cleanup.
  const versions = await repo.find({ where: { tenant: { id: tenantId } }, select: { id: true, publishedVersion: true } });
  const cached = await publishedCache.get<PublishedModule[]>(revisionKey(tenantId, method, versions));
  if (cached) return cached;
  const rows = await repo.find({ where: { tenant: { id: tenantId } }, relations: ['publishedSourceCode'], order: { publishedRoutePath: 'ASC', routePath: 'ASC' } });
  const modules = rows.filter((row) => row.publishedSourceCode && row.publishedVersion && (row.publishedMethod ?? row.method) === method)
    .map((row) => ({ routePath: row.publishedRoutePath ?? row.routePath, method: (row.publishedMethod ?? row.method) as HttpMethod,
      code: row.publishedSourceCode!.code, fileExtension: row.publishedFileExtension ?? row.fileExtension }));
  await publishedCache.set(revisionKey(tenantId, method, rows), modules);
  return modules;
}
