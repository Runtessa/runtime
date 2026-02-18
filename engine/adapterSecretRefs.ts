import { Tenant } from '@idp/shared';

export const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const getObjectValue = (
  object: Record<string, unknown>,
  key: string,
): unknown => {
  if (key in object) return object[key];
  const match = Object.keys(object).find((entry) => entry.toLowerCase() === key.toLowerCase());
  return match ? object[match] : undefined;
};

export const getObjectString = (
  object: Record<string, unknown>,
  key: string,
): string | null => {
  const value = getObjectValue(object, key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

export const parseJsonIfPossible = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const resolveRuntimeStageFromEnv = (): string => {
  const raw = String(
    process.env.CORE_ADAPTER_STAGE ||
      process.env.CORE_RUNTIME_STAGE ||
      process.env.IDP_STAGE ||
      process.env.NODE_ENV ||
      'dev',
  )
    .trim()
    .toLowerCase();
  if (!raw) return 'dev';
  if (raw === 'development') return 'dev';
  if (raw === 'production') return 'publish';
  if (raw === 'staging' || raw === 'stage') return 'prerelease';
  return raw;
};

const stageCandidatesFor = (runtimeStage: string): string[] => {
  const aliases: Record<string, string[]> = {
    dev: ['dev', 'development', 'local'],
    test: ['test', 'qa'],
    prerelease: ['prerelease', 'pre-release', 'staging', 'stage', 'uat'],
    publish: ['publish', 'production', 'prod'],
  };
  const runtime = runtimeStage.toLowerCase();
  const resolvedCanonical =
    Object.keys(aliases).find(
      (key) =>
        key === runtime || aliases[key].some((alias) => alias.toLowerCase() === runtime),
    ) || runtime;
  const candidates = [resolvedCanonical, ...(aliases[resolvedCanonical] || []), runtime];
  return Array.from(new Set(candidates.map((item) => item.toLowerCase())));
};

const resolveFromStageContainer = (
  value: unknown,
  mode: 'read' | 'write',
  stageCandidates: string[],
  depth: number,
): string | string[] | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = value as Record<string, unknown>;
  for (const stageName of stageCandidates) {
    const stageNode = getObjectValue(entries, stageName);
    if (stageNode === undefined) continue;
    const resolved = resolveSecretRefNode(stageNode, mode, stageCandidates, depth + 1);
    if (resolved) return resolved;
  }
  return null;
};

const resolveSecretRefNode = (
  value: unknown,
  mode: 'read' | 'write',
  stageCandidates: string[],
  depth: number,
): string | string[] | null => {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    const refs: string[] = [];
    value.forEach((entry) => {
      const resolved = resolveSecretRefNode(entry, mode, stageCandidates, depth + 1);
      if (typeof resolved === 'string') {
        refs.push(resolved);
      } else if (Array.isArray(resolved)) {
        refs.push(...resolved);
      }
    });
    const uniqueRefs = Array.from(new Set(refs.filter(Boolean)));
    return uniqueRefs.length ? uniqueRefs : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;

  const modeRefKeys =
    mode === 'read'
      ? ['readSecretRef', 'read_secret_ref', 'readRef', 'read_ref']
      : ['writeSecretRef', 'write_secret_ref', 'writeRef', 'write_ref'];
  for (const refKey of modeRefKeys) {
    const resolved = getObjectString(node, refKey);
    if (resolved) return resolved;
  }

  const genericRefKeys = ['secretRef', 'secret_ref', 'secretKey', 'secret_key', 'ref', 'key'];
  for (const refKey of genericRefKeys) {
    const resolved = getObjectString(node, refKey);
    if (resolved) return resolved;
  }

  const modeNode = getObjectValue(node, mode);
  if (modeNode !== undefined) {
    const resolved = resolveSecretRefNode(modeNode, mode, stageCandidates, depth + 1);
    if (resolved) return resolved;
  }

  const stageContainerKeys = ['stages', 'byStage', 'by_stage', 'environments', 'envs'];
  for (const containerKey of stageContainerKeys) {
    const resolved = resolveFromStageContainer(
      getObjectValue(node, containerKey),
      mode,
      stageCandidates,
      depth,
    );
    if (resolved) return resolved;
  }

  const hasInlineStageKey = stageCandidates.some(
    (stage) => getObjectValue(node, stage) !== undefined,
  );
  if (hasInlineStageKey) {
    const resolved = resolveFromStageContainer(node, mode, stageCandidates, depth);
    if (resolved) return resolved;
  }

  const fallbackKeys = ['default', 'fallback'];
  for (const fallbackKey of fallbackKeys) {
    const fallbackNode = getObjectValue(node, fallbackKey);
    if (fallbackNode === undefined) continue;
    const resolved = resolveSecretRefNode(fallbackNode, mode, stageCandidates, depth + 1);
    if (resolved) return resolved;
  }

  return null;
};

export const resolveSecretRefFromAdapterConfig = (
  tenant: Tenant,
  adapter: string,
  key: string,
  mode: 'read' | 'write',
  runtimeStage: string,
): string | string[] | null => {
  const root = asObject((tenant.adapterConfig as any)?.adapters ?? tenant.adapterConfig);
  const adapterBlock = getObjectValue(root, adapter);
  if (!adapterBlock || typeof adapterBlock !== 'object' || Array.isArray(adapterBlock)) {
    return null;
  }
  const adapterEntries = adapterBlock as Record<string, unknown>;
  const entry = getObjectValue(adapterEntries, key);
  if (entry === undefined) return null;
  return resolveSecretRefNode(entry, mode, stageCandidatesFor(runtimeStage), 0);
};
