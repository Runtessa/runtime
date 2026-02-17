import { randomBytes } from 'crypto';
import Redis from 'ioredis';
import { CoreAuthUser } from '../../types/AuthUser';

export interface TenantSessionRecord {
  id: string;
  tenantId: string;
  tenantHost: string;
  user: CoreAuthUser;
  createdAt: string;
  lastSeenAt: string;
}

interface MemorySessionEntry {
  expiresAt: number;
  record: TenantSessionRecord;
}

export class TenantSessionStore {
  private readonly redis: Redis | null;

  private readonly memory = new Map<string, MemorySessionEntry>();

  private readonly keyPrefix: string;

  private readonly ttlSec: number;

  constructor({
    redisUrl,
    ttlSec,
    keyPrefix = 'idp:tenant:sso:session',
  }: {
    redisUrl?: string;
    ttlSec: number;
    keyPrefix?: string;
  }) {
    this.ttlSec = Math.max(60, Math.floor(ttlSec));
    this.keyPrefix = keyPrefix;

    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
      });
      this.redis.on('error', (error) => {
        console.warn(`[tenant-sso] redis unavailable, using memory fallback: ${error.message}`);
      });
    } else {
      this.redis = null;
    }
  }

  private key(id: string): string {
    return `${this.keyPrefix}:${id}`;
  }

  private newSessionId(): string {
    return randomBytes(32).toString('base64url');
  }

  private setMemory(record: TenantSessionRecord): void {
    this.memory.set(record.id, {
      expiresAt: Date.now() + this.ttlSec * 1000,
      record,
    });
  }

  private getMemory(id: string): TenantSessionRecord | null {
    const entry = this.memory.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(id);
      return null;
    }
    return entry.record;
  }

  async create(
    input: Omit<TenantSessionRecord, 'id' | 'createdAt' | 'lastSeenAt'>,
  ): Promise<TenantSessionRecord> {
    const nowIso = new Date().toISOString();
    const record: TenantSessionRecord = {
      ...input,
      id: this.newSessionId(),
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };

    const payload = JSON.stringify(record);
    if (this.redis) {
      try {
        await this.redis.set(this.key(record.id), payload, 'EX', this.ttlSec);
        return record;
      } catch {
        // fall back to memory
      }
    }

    this.setMemory(record);
    return record;
  }

  async get(id: string): Promise<TenantSessionRecord | null> {
    if (!id) return null;
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.key(id));
        if (!raw) return null;
        return JSON.parse(raw) as TenantSessionRecord;
      } catch {
        return null;
      }
    }
    return this.getMemory(id);
  }

  async touch(id: string): Promise<TenantSessionRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: TenantSessionRecord = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
    };
    const payload = JSON.stringify(updated);

    if (this.redis) {
      try {
        await this.redis.set(this.key(id), payload, 'EX', this.ttlSec);
        return updated;
      } catch {
        return null;
      }
    }

    this.setMemory(updated);
    return updated;
  }

  async destroy(id: string): Promise<void> {
    if (!id) return;
    if (this.redis) {
      try {
        await this.redis.del(this.key(id));
      } catch {
        // ignore
      }
      return;
    }
    this.memory.delete(id);
  }
}
