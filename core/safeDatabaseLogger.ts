import type { Logger } from 'typeorm';

// SQL text itself can contain inline literals. Record only event type and timing,
// even when DB_LOGGING enables query diagnostics.
export class SafeDatabaseLogger implements Logger {
  constructor(private readonly enabled = false) {}
  logQuery(): void { if (this.enabled) console.debug('[database] query executed'); }
  logQueryError(): void { if (this.enabled) console.error('[database] query failed'); }
  logQuerySlow(time: number): void { if (this.enabled) console.warn('[database] slow query', { durationMs: time }); }
  logSchemaBuild(): void { if (this.enabled) console.debug('[database] schema operation'); }
  logMigration(): void { if (this.enabled) console.debug('[database] migration operation'); }
  log(level: 'log' | 'info' | 'warn'): void {
    if (!this.enabled) return;
    if (level === 'warn') console.warn('[database] warning');
    else console.debug('[database] diagnostic');
  }
}
