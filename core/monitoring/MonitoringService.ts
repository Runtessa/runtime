import os from 'os';
import { statfs } from 'fs/promises';
import { randomUUID } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import Redis from 'ioredis';
import { Request, Response, NextFunction } from 'express';
import { Tenant } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

type TenantWindowStat = {
  tenantId: string | null;
  tenantHostname: string;
  requests: number;
  errors: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  latencies: number[];
  networkInBytes: number;
  networkOutBytes: number;
};

type MonitoringRule = {
  id: string;
  name: string;
  enabled: boolean;
  scope: 'global' | 'instance' | 'tenant';
  tenantId?: string | null;
  metricKey: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  cooldownSec: number;
  severity: 'info' | 'warning' | 'critical';
  webhookUrl?: string | null;
  webhookMethod?: string | null;
  webhookHeaders?: Record<string, string> | null;
};

type TenantSample = {
  tenantId: string | null;
  tenantHostname: string | null;
  requestCount: number;
  errorCount: number;
  errorRatePct: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  networkInBytes: number;
  networkOutBytes: number;
};

type SnapshotPayload = {
  id: string;
  createdAt: string;
  serverName: string;
  instanceId: string;
  instanceName: string;
  cpuPercent: number;
  memoryRssMb: number;
  memoryHeapUsedMb: number;
  memoryHeapTotalMb: number;
  storageTotalMb: number;
  storageUsedMb: number;
  storageFreeMb: number;
  storageUsedPct: number;
  threadActiveHandles: number;
  threadActiveRequests: number;
  eventLoopLagMs: number;
  networkInBytes: number;
  networkOutBytes: number;
  requestCount: number;
  errorCount: number;
  errorRatePct: number;
  tenantSamples: TenantSample[];
};

type AlertEventPayload = {
  id: string;
  ruleId: string;
  ruleName: string;
  tenantId?: string | null;
  tenantHostname?: string | null;
  serverName: string;
  instanceId: string;
  instanceName: string;
  metricKey: string;
  metricValue: number;
  threshold: number;
  operator: string;
  severity: string;
  status: string;
  webhookStatus?: string | null;
  webhookResponse?: string | null;
  webhookTarget?: string | null;
  createdAt: string;
};

const MB = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 4000;
// Keep one day by default at ~4s sampling cadence.
const DEFAULT_RETENTION = 21600;
const ALERT_RETENTION = 5000;
const MAX_LATENCY_SAMPLES = 2000;
const KEY = {
  instances: 'monitoring:instances',
  rulesIds: 'monitoring:rules:ids',
  rulesData: 'monitoring:rules:data',
  alerts: 'monitoring:alerts',
  ingestDedupSnapshot: (id: string) => `monitoring:ingest:dedup:snapshot:${id}`,
  ingestDedupAlert: (id: string) => `monitoring:ingest:dedup:alert:${id}`,
  meta: (instanceKey: string) => `monitoring:instance:${instanceKey}:meta`,
  heartbeat: (instanceKey: string) => `monitoring:instance:${instanceKey}:heartbeat`,
  snapshots: (instanceKey: string) => `monitoring:snapshots:${instanceKey}`,
};

export class MonitoringService {
  private readonly intervalMs: number;
  private readonly retention: number;
  private readonly serverName: string;
  private readonly instanceId: string;
  private readonly instanceName: string;
  private readonly instanceKey: string;
  private readonly storagePath: string;
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private readonly tenantWindowStats = new Map<string, TenantWindowStat>();
  private readonly alertCooldowns = new Map<string, number>();
  private prevCpu = process.cpuUsage();
  private prevCpuTime = process.hrtime.bigint();
  private globalRequests = 0;
  private globalErrors = 0;
  private globalNetworkInBytes = 0;
  private globalNetworkOutBytes = 0;
  private redis: Redis | null;
  private redisUnavailableLogged = false;
  private readonly monitoringPubSubChannel: string;

  constructor() {
    const requestedInterval = Number.parseInt(process.env.MONITORING_INTERVAL_MS || '', 10) || DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.min(Math.max(requestedInterval, 1000), 4900);
    this.retention = Number.parseInt(process.env.MONITORING_RETENTION_POINTS || '', 10) || DEFAULT_RETENTION;
    this.serverName = process.env.SERVER_NAME?.trim() || os.hostname();
    this.instanceName =
      process.env.INSTANCE_NAME?.trim() || process.env.INSTANCE_ID?.trim() || `${this.serverName}-${process.pid}`;
    // Monitoring identity is instance-name based so restarts replace the same instance.
    this.instanceId = this.instanceName;
    this.instanceKey = `${this.serverName}::${this.instanceId}`;
    this.storagePath = process.env.MONITORING_STORAGE_PATH?.trim() || process.cwd();
    this.monitoringPubSubChannel =
      process.env.MONITORING_PUBSUB_CHANNEL?.trim() || 'idp:monitoring:ingest';
    this.redis = this.getRedisClient();
    this.eventLoop.enable();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.collectSnapshot();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private resolveTenantHostname(req: Request) {
    const headerOverride = (req.headers['x-tenant-host'] as string | undefined)
      ?.toLowerCase()
      .trim();
    let hostname = (req.hostname || '').toLowerCase().trim();

    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
      hostname = headerOverride || '';
    }

    return hostname || '';
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const startedAt = process.hrtime.bigint();
      const headerLength = Number.parseInt(String(req.headers['content-length'] || '0'), 10);
      const bytesIn = Number.isFinite(headerLength) ? Math.max(headerLength, 0) : 0;

      res.on('finish', () => {
        const tenantReq = req as TenantRequest;
        const tenant = tenantReq.tenant as Tenant | undefined;
        const tenantId = tenant?.id || null;
        const tenantHostname = tenant?.hostname || this.resolveTenantHostname(req);
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const statusCode = res.statusCode || 0;
        const contentLength = Number.parseInt(String(res.getHeader('content-length') || '0'), 10);
        const bytesOut = Number.isFinite(contentLength) ? Math.max(contentLength, 0) : 0;

        this.globalRequests += 1;
        this.globalNetworkInBytes += bytesIn;
        this.globalNetworkOutBytes += bytesOut;
        if (statusCode >= 500) this.globalErrors += 1;

        if (tenantId || tenantHostname) {
          const tenantStat = this.ensureTenantWindowStat(tenantId, tenantHostname);
          tenantStat.networkInBytes += bytesIn;
          tenantStat.requests += 1;
          if (statusCode >= 500) tenantStat.errors += 1;
          tenantStat.totalLatencyMs += latencyMs;
          tenantStat.maxLatencyMs = Math.max(tenantStat.maxLatencyMs, latencyMs);
          tenantStat.networkOutBytes += bytesOut;
          if (tenantStat.latencies.length < MAX_LATENCY_SAMPLES) {
            tenantStat.latencies.push(latencyMs);
          }
        }
      });

      next();
    };
  }

  private getRedisClient() {
    const redisUrl =
      process.env.MONITORING_REDIS_URL || process.env.CACHE_REDIS_URL || process.env.REDIS_URL;
    if (!redisUrl) return null;

    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    client.on('error', (err) => {
      if (!this.redisUnavailableLogged) {
        this.redisUnavailableLogged = true;
        console.warn(`[monitoring] redis unavailable: ${err.message}`);
      }
    });

    return client;
  }

  private tenantKey(tenantId: string | null, tenantHostname: string) {
    if (tenantId) return `id:${tenantId}`;
    return `host:${tenantHostname || 'unknown'}`;
  }

  private ensureTenantWindowStat(tenantId: string | null, tenantHostname: string): TenantWindowStat {
    const key = this.tenantKey(tenantId, tenantHostname);
    const existing = this.tenantWindowStats.get(key);
    if (existing) {
      if (tenantHostname) existing.tenantHostname = tenantHostname;
      return existing;
    }

    const created: TenantWindowStat = {
      tenantId: tenantId || null,
      tenantHostname,
      requests: 0,
      errors: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      latencies: [],
      networkInBytes: 0,
      networkOutBytes: 0,
    };
    this.tenantWindowStats.set(key, created);
    return created;
  }

  private async collectSnapshot() {
    if (this.tickRunning) return;
    this.tickRunning = true;

    try {
      const metrics = await this.collectInstanceMetrics();
      const tenantSamples = this.buildTenantSamples();

      const snapshot: SnapshotPayload = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        serverName: this.serverName,
        instanceId: this.instanceId,
        instanceName: this.instanceName,
        cpuPercent: metrics.cpuPercent,
        memoryRssMb: metrics.memoryRssMb,
        memoryHeapUsedMb: metrics.memoryHeapUsedMb,
        memoryHeapTotalMb: metrics.memoryHeapTotalMb,
        storageTotalMb: metrics.storageTotalMb,
        storageUsedMb: metrics.storageUsedMb,
        storageFreeMb: metrics.storageFreeMb,
        storageUsedPct: metrics.storageUsedPct,
        threadActiveHandles: metrics.threadActiveHandles,
        threadActiveRequests: metrics.threadActiveRequests,
        eventLoopLagMs: metrics.eventLoopLagMs,
        networkInBytes: metrics.networkInBytes,
        networkOutBytes: metrics.networkOutBytes,
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        errorRatePct: metrics.errorRatePct,
        tenantSamples,
      };

      if (this.redis) {
        const ttlSec = Math.max(Math.ceil((this.intervalMs * 3) / 1000), 10);
        const pipeline = this.redis.pipeline();
        pipeline.sadd(KEY.instances, this.instanceKey);
        pipeline.set(KEY.meta(this.instanceKey), JSON.stringify({
          serverName: this.serverName,
          instanceId: this.instanceId,
          instanceName: this.instanceName,
          pid: process.pid,
          startedAt: snapshot.createdAt,
        }));
        pipeline.set(KEY.heartbeat(this.instanceKey), String(Date.now()), 'EX', ttlSec);
        pipeline.set(KEY.ingestDedupSnapshot(snapshot.id), '1', 'EX', 60 * 60 * 24);
        pipeline.lpush(KEY.snapshots(this.instanceKey), JSON.stringify(snapshot));
        pipeline.ltrim(KEY.snapshots(this.instanceKey), 0, this.retention - 1);
        await pipeline.exec();
        await this.evaluateAlerts(snapshot);
      }

      void this.publishMonitoringData({ snapshot });
      this.resetWindowStats();
    } catch (error) {
      console.error('[monitoring] snapshot collection failed:', (error as Error).message);
    } finally {
      this.tickRunning = false;
    }
  }

  private async collectInstanceMetrics() {
    const usage = process.cpuUsage(this.prevCpu);
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - this.prevCpuTime) / 1_000_000;
    this.prevCpu = process.cpuUsage();
    this.prevCpuTime = now;

    const cpuCount = Math.max(os.cpus().length, 1);
    const cpuMs = (usage.user + usage.system) / 1000;
    const cpuPercent = elapsedMs > 0 ? Math.min((cpuMs / (elapsedMs * cpuCount)) * 100, 1000) : 0;

    const mem = process.memoryUsage();
    const threadActiveHandles =
      typeof (process as any)._getActiveHandles === 'function'
        ? (process as any)._getActiveHandles().length
        : 0;
    const threadActiveRequests =
      typeof (process as any)._getActiveRequests === 'function'
        ? (process as any)._getActiveRequests().length
        : 0;

    let storageTotalMb = 0;
    let storageFreeMb = 0;
    let storageUsedMb = 0;
    let storageUsedPct = 0;

    try {
      const storage = await statfs(this.storagePath);
      const blockSize = Number((storage as any).bsize || 0);
      const blocks = Number((storage as any).blocks || 0);
      const bavail = Number((storage as any).bavail || 0);
      const total = blockSize * blocks;
      const free = blockSize * bavail;
      const used = Math.max(total - free, 0);
      storageTotalMb = total / MB;
      storageFreeMb = free / MB;
      storageUsedMb = used / MB;
      storageUsedPct = total > 0 ? (used / total) * 100 : 0;
    } catch {
      // ignore storage probe failure
    }

    const eventLoopLagMs = Number(this.eventLoop.mean || 0) / 1_000_000;
    this.eventLoop.reset();

    const requestCount = this.globalRequests;
    const errorCount = this.globalErrors;

    return {
      cpuPercent,
      memoryRssMb: mem.rss / MB,
      memoryHeapUsedMb: mem.heapUsed / MB,
      memoryHeapTotalMb: mem.heapTotal / MB,
      storageTotalMb,
      storageFreeMb,
      storageUsedMb,
      storageUsedPct,
      threadActiveHandles,
      threadActiveRequests,
      eventLoopLagMs,
      networkInBytes: this.globalNetworkInBytes,
      networkOutBytes: this.globalNetworkOutBytes,
      requestCount,
      errorCount,
      errorRatePct: requestCount > 0 ? (errorCount / requestCount) * 100 : 0,
    };
  }

  private buildTenantSamples(): TenantSample[] {
    const rows: TenantSample[] = [];
    this.tenantWindowStats.forEach((stat) => {
      const sortedLatencies = [...stat.latencies].sort((a, b) => a - b);
      const p95Index = sortedLatencies.length
        ? Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))
        : 0;
      const p95LatencyMs = sortedLatencies.length ? sortedLatencies[p95Index] : 0;
      const avgLatencyMs = stat.requests > 0 ? stat.totalLatencyMs / stat.requests : 0;
      const errorRatePct = stat.requests > 0 ? (stat.errors / stat.requests) * 100 : 0;

      rows.push({
        tenantId: stat.tenantId || null,
        tenantHostname: stat.tenantHostname || null,
        requestCount: stat.requests,
        errorCount: stat.errors,
        errorRatePct,
        avgLatencyMs,
        p95LatencyMs,
        maxLatencyMs: stat.maxLatencyMs,
        networkInBytes: stat.networkInBytes,
        networkOutBytes: stat.networkOutBytes,
      });
    });

    return rows;
  }

  private async loadRules(): Promise<MonitoringRule[]> {
    if (!this.redis) return [];

    const ids = await this.redis.smembers(KEY.rulesIds);
    if (!ids.length) return [];

    const rules: MonitoringRule[] = [];
    const pipeline = this.redis.pipeline();
    ids.forEach((id) => pipeline.hget(KEY.rulesData, id));
    const result = await pipeline.exec();

    result?.forEach((entry, idx) => {
      if (!entry || entry[0]) return;
      const raw = entry[1];
      if (!raw || typeof raw !== 'string') return;
      try {
        const parsed = JSON.parse(raw) as MonitoringRule;
        if (parsed && parsed.id) rules.push(parsed);
      } catch {
        const id = ids[idx];
        if (id) void this.redis?.hdel(KEY.rulesData, id);
      }
    });

    return rules;
  }

  private async evaluateAlerts(snapshot: SnapshotPayload) {
    if (!this.redis) return;

    const rules = await this.loadRules();
    if (!rules.length) return;

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const cooldownUntil = this.alertCooldowns.get(rule.id) || 0;
      if (cooldownUntil > Date.now()) continue;

      if (rule.scope === 'tenant') {
        const targets = snapshot.tenantSamples.filter((sample) =>
          rule.tenantId ? sample.tenantId === rule.tenantId : true
        );
        for (const sample of targets) {
          const metricValue = this.resolveTenantMetric(rule.metricKey, sample);
          if (!this.compareMetric(rule.operator, metricValue, rule.threshold)) continue;
          await this.emitAlert(rule, snapshot, metricValue, sample.tenantId, sample.tenantHostname);
        }
        continue;
      }

      const metricValue = this.resolveSnapshotMetric(rule.metricKey, snapshot);
      if (!this.compareMetric(rule.operator, metricValue, rule.threshold)) continue;
      await this.emitAlert(rule, snapshot, metricValue, null, null);
    }
  }

  private async emitAlert(
    rule: MonitoringRule,
    snapshot: SnapshotPayload,
    metricValue: number,
    tenantId: string | null,
    tenantHostname: string | null
  ) {
    const event: AlertEventPayload = {
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      tenantId,
      tenantHostname,
      serverName: snapshot.serverName,
      instanceId: snapshot.instanceId,
      instanceName: snapshot.instanceName,
      metricKey: rule.metricKey,
      metricValue,
      threshold: rule.threshold,
      operator: rule.operator,
      severity: rule.severity,
      status: 'triggered',
      webhookStatus: null,
      webhookTarget: rule.webhookUrl || null,
      createdAt: new Date().toISOString(),
    };

    this.applyCooldown(rule);

    if (this.redis) {
      await this.redis
        .multi()
        .set(KEY.ingestDedupAlert(event.id), '1', 'EX', 60 * 60 * 24)
        .lpush(KEY.alerts, JSON.stringify(event))
        .ltrim(KEY.alerts, 0, ALERT_RETENTION - 1)
        .exec();
    }

    void this.publishMonitoringData({ alert: event });
    void this.dispatchWebhook(rule, event);
  }

  private async publishMonitoringData(payload: { snapshot?: SnapshotPayload; alert?: AlertEventPayload }) {
    if (!this.redis) return;
    try {
      await this.redis.publish(this.monitoringPubSubChannel, JSON.stringify(payload));
    } catch (error) {
      if (!this.redisUnavailableLogged) {
        this.redisUnavailableLogged = true;
        console.warn(`[monitoring] publish unavailable: ${(error as Error).message}`);
      }
    }
  }

  private resolveSnapshotMetric(metricKey: string, snapshot: SnapshotPayload): number {
    switch (metricKey) {
      case 'cpu_percent':
        return snapshot.cpuPercent;
      case 'memory_rss_mb':
        return snapshot.memoryRssMb;
      case 'memory_heap_used_mb':
        return snapshot.memoryHeapUsedMb;
      case 'event_loop_lag_ms':
        return snapshot.eventLoopLagMs;
      case 'error_rate_pct':
        return snapshot.errorRatePct;
      case 'storage_used_pct':
        return snapshot.storageUsedPct;
      case 'thread_active_handles':
        return snapshot.threadActiveHandles;
      case 'thread_active_requests':
        return snapshot.threadActiveRequests;
      case 'network_in_bytes':
        return snapshot.networkInBytes;
      case 'network_out_bytes':
        return snapshot.networkOutBytes;
      default:
        return 0;
    }
  }

  private resolveTenantMetric(metricKey: string, sample: TenantSample): number {
    switch (metricKey) {
      case 'tenant_request_count':
        return sample.requestCount;
      case 'tenant_error_rate_pct':
        return sample.errorRatePct;
      case 'tenant_avg_latency_ms':
        return sample.avgLatencyMs;
      case 'tenant_p95_latency_ms':
        return sample.p95LatencyMs;
      case 'tenant_max_latency_ms':
        return sample.maxLatencyMs;
      case 'tenant_network_in_bytes':
        return sample.networkInBytes;
      case 'tenant_network_out_bytes':
        return sample.networkOutBytes;
      default:
        return 0;
    }
  }

  private compareMetric(operator: string, value: number, threshold: number): boolean {
    switch (operator) {
      case 'gt':
        return value > threshold;
      case 'gte':
        return value >= threshold;
      case 'lt':
        return value < threshold;
      case 'lte':
        return value <= threshold;
      default:
        return false;
    }
  }

  private applyCooldown(rule: MonitoringRule) {
    const cooldownMs = Math.max(rule.cooldownSec || 0, 0) * 1000;
    if (!cooldownMs) return;
    this.alertCooldowns.set(rule.id, Date.now() + cooldownMs);
  }

  private async dispatchWebhook(rule: MonitoringRule, event: AlertEventPayload) {
    if (!rule.webhookUrl || !this.redis) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    timeout.unref?.();

    const updateEventStatus = async (status: string, response?: string) => {
      const rows = await this.redis!.lrange(KEY.alerts, 0, 300);
      const parsed = rows.map((raw) => {
        try {
          return JSON.parse(raw) as AlertEventPayload;
        } catch {
          return null;
        }
      });
      const target = parsed.find((item) => item?.id === event.id);
      if (!target) return;
      target.webhookStatus = status;
      if (response) target.webhookResponse = response;
      await this.redis!.lrem(KEY.alerts, 1, rows[parsed.findIndex((item) => item?.id === event.id)]);
      await this.redis!.lpush(KEY.alerts, JSON.stringify(target));
      await this.redis!.ltrim(KEY.alerts, 0, ALERT_RETENTION - 1);
    };

    try {
      const response = await fetch(rule.webhookUrl, {
        method: (rule.webhookMethod || 'POST').toUpperCase(),
        headers: {
          'content-type': 'application/json',
          ...(rule.webhookHeaders || {}),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      await updateEventStatus(response.ok ? `ok:${response.status}` : `error:${response.status}`);
    } catch (error) {
      await updateEventStatus('error', (error as Error).message?.slice(0, 2000) || 'webhook failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private resetWindowStats() {
    this.tenantWindowStats.clear();
    this.globalRequests = 0;
    this.globalErrors = 0;
    this.globalNetworkInBytes = 0;
    this.globalNetworkOutBytes = 0;
  }
}
