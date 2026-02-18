import { HttpMethod } from '@idp/shared';

type ModuleLike = {
  routePath: string;
  method: HttpMethod;
  code: string;
  fileExtension?: string;
};

export const matchPath = (pattern: string, actual: string): Record<string, string> | null => {
  const patternParts = pattern.split('/').filter(Boolean);
  const actualParts = actual.split('/').filter(Boolean);

  if (patternParts.length !== actualParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const pp = patternParts[i];
    const ap = actualParts[i];
    if (pp.startsWith(':')) {
      params[pp.substring(1)] = decodeURIComponent(ap);
    } else if (pp !== ap) {
      return null;
    }
  }
  return params;
};

export const findMatchingModule = (
  modules: ModuleLike[],
  path: string,
): { module: ModuleLike; params: Record<string, string> } | null => {
  for (const mod of modules) {
    const params = matchPath(mod.routePath, path);
    if (params) {
      return { module: mod, params };
    }
  }
  return null;
};

export const publishedModulesCacheKey = (tenantId: string, method: HttpMethod) => {
  return `module:published:${tenantId}:${method}`;
};
