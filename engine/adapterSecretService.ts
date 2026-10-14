import { DataSource } from 'typeorm';
import { Secret, Tenant } from '@idp/shared';
import { CryptoService } from '../core/security/CryptoService';
import { parseJsonIfPossible, resolveSecretRefFromAdapterConfig } from './adapterSecretRefs';

export class AdapterSecretService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cryptoService: CryptoService,
    private readonly runtimeStage: string,
  ) {}

  async getSecretValue(tenant: Tenant, keyName: string): Promise<string> {
    const repo = this.dataSource.getRepository(Secret);
    let secret = await repo.findOne({ where: { tenant: { id: tenant.id }, keyName } });
    if (!secret) {
      secret = await repo
        .createQueryBuilder('secret')
        .where('secret."keyName" = :keyName', { keyName })
        .andWhere('secret."tenantId" = :tenantId', { tenantId: tenant.id })
        .getOne();
    }
    if (!secret) {
      const rows = await repo.query(
        'select "encryptedValue", "iv", "authTag" from secrets where "tenantId" = $1 and "keyName" = $2 limit 1',
        [tenant.id, keyName],
      );
      if (Array.isArray(rows) && rows[0]) {
        return this.cryptoService.decryptSecret({
          encryptedValue: rows[0].encryptedValue,
          iv: rows[0].iv,
          authTag: rows[0].authTag,
        });
      }
    }
    if (!secret) {
      let debugInfo = '';
      try {
        const result = await repo.query('select current_database() as db');
        const dbName = Array.isArray(result) && result[0]?.db ? result[0].db : 'unknown';
        const countResult = await repo.query(
          'select count(*)::int as count from secrets where "tenantId" = $1',
          [tenant.id],
        );
        const count =
          Array.isArray(countResult) && typeof countResult[0]?.count === 'number'
            ? countResult[0].count
            : Number(countResult[0]?.count ?? 0);
        debugInfo = ` (db=${dbName}, tenantSecrets=${count})`;
      } catch {
        // ignore debug failures
      }
      throw new Error(`Secret ${keyName} not found for tenant${debugInfo}`);
    }
    try {
      return this.cryptoService.decryptSecret({
        encryptedValue: secret.encryptedValue,
        authTag: secret.authTag,
        iv: secret.iv,
      });
    } catch {
      throw new Error(`Secret ${keyName} found but failed to decrypt`);
    }
  }

  async resolveSecretValue(
    tenant: Tenant,
    adapter: string,
    key: string,
    mode: 'read' | 'write' = 'write',
  ): Promise<string> {
    const rawKey = key.trim();
    const lowerKey = rawKey.toLowerCase();
    const configuredSecretRef = resolveSecretRefFromAdapterConfig(
      tenant,
      adapter,
      lowerKey,
      mode,
      this.runtimeStage,
    );
    if (configuredSecretRef) {
      if (Array.isArray(configuredSecretRef)) {
        const resolvedValues: unknown[] = [];
        for (const ref of configuredSecretRef) {
          try {
            const raw = await this.getSecretValue(tenant, ref);
            resolvedValues.push(parseJsonIfPossible(raw));
          } catch (err) {
            if (err instanceof Error && err.message.includes('failed to decrypt')) {
              throw err;
            }
            throw new Error(
              `Secret ${ref} referenced by adapter ${adapter}:${rawKey} not found for tenant ${tenant.id}`,
            );
          }
        }
        return JSON.stringify(resolvedValues);
      }
      try {
        return await this.getSecretValue(tenant, configuredSecretRef);
      } catch (err) {
        if (err instanceof Error && err.message.includes('failed to decrypt')) {
          throw err;
        }
        throw new Error(
          `Secret ${configuredSecretRef} referenced by adapter ${adapter}:${rawKey} not found for tenant ${tenant.id}`,
        );
      }
    }
    const stage = this.runtimeStage.toLowerCase();
    const candidates = [
      `adapter:${adapter}:${lowerKey}:${stage}:${mode}`,
      `adapter:${adapter}:${rawKey}:${stage}:${mode}`,
      `adapter:${adapter}:${lowerKey}:${stage}:${mode}:1`,
      `adapter:${adapter}:${rawKey}:${stage}:${mode}:1`,
      `adapter:${adapter}:${lowerKey}:${stage}`,
      `adapter:${adapter}:${rawKey}:${stage}`,
      `adapter:${adapter}:${lowerKey}:default:${mode}`,
      `adapter:${adapter}:${rawKey}:default:${mode}`,
      `adapter:${adapter}:${lowerKey}:default:${mode}:1`,
      `adapter:${adapter}:${rawKey}:default:${mode}:1`,
      `adapter:${adapter}:${lowerKey}:default`,
      `adapter:${adapter}:${rawKey}:default`,
      `adapter:${adapter}:${lowerKey}`,
      `adapter:${adapter}:${rawKey}`,
      `${adapter}:${lowerKey}`,
      `${adapter}:${rawKey}`,
      lowerKey,
      rawKey,
    ];
    const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
    for (const candidate of uniqueCandidates) {
      try {
        return await this.getSecretValue(tenant, candidate);
      } catch (err) {
        if (err instanceof Error && err.message.includes('failed to decrypt')) {
          throw err;
        }
      }
    }
    let debugInfo = '';
    try {
      const repo = this.dataSource.getRepository(Secret);
      const result = await repo.query('select current_database() as db');
      const dbName = Array.isArray(result) && result[0]?.db ? result[0].db : 'unknown';
      const countResult = await repo.query(
        'select count(*)::int as count from secrets where "tenantId" = $1',
        [tenant.id],
      );
      const count =
        Array.isArray(countResult) && typeof countResult[0]?.count === 'number'
          ? countResult[0].count
          : Number(countResult[0]?.count ?? 0);
      let keys: string[] = [];
      if (count > 0) {
        const rows = await repo.query(
          'select "keyName" from secrets where "tenantId" = $1',
          [tenant.id],
        );
        keys = Array.isArray(rows) ? rows.map((row) => row.keyName) : [];
      }
      debugInfo = ` (db=${dbName}, tenantSecrets=${count}, keys=${keys.join('|')})`;
    } catch {
      // ignore debug failures
    }
    throw new Error(
      `Secret ${rawKey} not found for tenant ${tenant.id}. Tried keys: ${uniqueCandidates.join(', ')}${debugInfo}`,
    );
  }

  selectReadWriteConfig(secretVal: string, mode: 'read' | 'write') {
    let parsed: any;
    try { parsed = JSON.parse(secretVal); } catch { return secretVal; }
    if (!parsed || typeof parsed !== 'object') return secretVal;
    if ('read' in parsed || 'write' in parsed) {
      const readVal = (parsed as any).read;
      const writeVal = (parsed as any).write;
      const selected = mode === 'read' ? readVal ?? writeVal : writeVal ?? readVal;
      return this.decryptPasswordMarkers(selected ?? secretVal);
    }
    return this.decryptPasswordMarkers(parsed);
  }

  normalizeDbConfig(config: Record<string, unknown>) {
    const normalized = { ...config } as Record<string, unknown>;
    if (!normalized.user && typeof normalized.username === 'string') {
      normalized.user = normalized.username;
    }
    if (!normalized.username && typeof normalized.user === 'string') {
      normalized.username = normalized.user;
    }
    return normalized;
  }

  private decryptPasswordMarkers(value: unknown): unknown {
    const decode = (entry: unknown): unknown => {
      if (Array.isArray(entry)) {
        return entry.map((item) => decode(item));
      }
      if (entry && typeof entry === 'object') {
        const next: Record<string, unknown> = {};
        Object.entries(entry as Record<string, unknown>).forEach(([key, val]) => {
          if (key === 'password' && typeof val === 'string' && val.startsWith('enc:')) {
            const parts = val.split(':');
            if (parts.length === 4) {
              try {
                next[key] = this.cryptoService.decryptSecret({
                  iv: parts[1],
                  authTag: parts[2],
                  encryptedValue: parts[3],
                });
                return;
              } catch {
                throw new Error('Adapter password could not be decrypted with the configured keys');
              }
            }
          }
          next[key] = decode(val);
        });
        return next;
      }
      return entry;
    };
    return decode(value);
  }
}
