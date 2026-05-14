import { NextFunction, Response } from 'express';
import { DataSource, IsNull } from 'typeorm';
import {
  OrchestrationAgent,
  OrchestrationAgentStatus,
  OrchestrationOperation,
  OrchestrationOperationStatus,
  OrchestrationOperationType,
  OrchestrationPlacement,
  OrchestrationPlacementStatus,
  OrchestrationWorkload,
  OrchestrationWorkloadState,
  Tenant,
} from '@idp/shared';
import { AppError } from '../../common/AppError';
import { TenantRequest } from '../../types/RequestContext';

const VALID_OPERATION_TYPES = new Set<OrchestrationOperationType>([
  'create',
  'update',
  'scale',
  'stop',
  'remove',
  'reconcile',
]);

const VALID_WORKLOAD_STATES = new Set<OrchestrationWorkloadState>(['running', 'stopped', 'removed']);
const VALID_AGENT_STATUSES = new Set<OrchestrationAgentStatus>(['online', 'degraded', 'offline']);
const VALID_PLACEMENT_STATUSES = new Set<OrchestrationPlacementStatus>([
  'pending',
  'running',
  'failed',
  'removed',
]);
const VALID_RUNTIME_TYPES = new Set(['docker', 'k8s']);

export class OrchestrationController {
  constructor(private readonly dataSource: DataSource) {}

  listAgents = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationAgent);
      const agents = await repo.find({
        where: { tenantId: tenant.id },
        order: { heartbeatAt: 'DESC', updatedAt: 'DESC' },
      });
      res.json(agents);
    } catch (error) {
      next(error);
    }
  };

  heartbeatAgent = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const key = this.requireString(req.body?.key, 'key', 128);
      const runtimeType = this.normalizeRuntimeType(req.body?.runtimeType, 'docker');
      const status = this.normalizeAgentStatus(req.body?.status, 'online');

      const repo = this.dataSource.getRepository(OrchestrationAgent);
      const existing = await repo.findOne({ where: { tenantId: tenant.id, key } });
      const heartbeatAt = new Date();
      const partial = {
        key,
        tenant,
        tenantId: tenant.id,
        runtimeType,
        status,
        displayName: this.normalizeString(req.body?.displayName, 160),
        serverHost: this.normalizeString(req.body?.serverHost, 255),
        labels: this.normalizeStringMap(req.body?.labels),
        capacity: this.normalizeCapacity(req.body?.capacity),
        metadata: this.normalizeLooseObject(req.body?.metadata),
        heartbeatAt,
      };

      const saved = await repo.save(existing ? repo.merge(existing, partial) : repo.create(partial));
      res.status(existing ? 200 : 201).json(saved);
    } catch (error) {
      next(error);
    }
  };

  listWorkloads = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationWorkload);
      const workloads = await repo.find({
        where: { tenantId: tenant.id },
        order: { updatedAt: 'DESC' },
      });
      res.json(workloads);
    } catch (error) {
      next(error);
    }
  };

  getWorkload = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const workload = await this.findWorkloadOrThrow(tenant.id, req.params.id);
      res.json(workload);
    } catch (error) {
      next(error);
    }
  };

  createWorkload = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationWorkload);
      const key = this.requireString(req.body?.key, 'key', 160);
      const existing = await repo.findOne({ where: { tenantId: tenant.id, key } });
      if (existing) {
        throw new AppError('Workload key already exists', 409);
      }

      const workload = repo.create({
        tenant,
        tenantId: tenant.id,
        key,
        name: this.requireString(req.body?.name, 'name', 200),
        runtimeType: this.normalizeRuntimeType(req.body?.runtimeType, 'docker'),
        state: this.normalizeWorkloadState(req.body?.state, 'running'),
        image: this.requireString(req.body?.image, 'image', 255),
        desiredReplicas: this.normalizeReplicas(req.body?.desiredReplicas, 1),
        revision: 1,
        config: this.normalizeLooseObject(req.body?.config),
        placement: this.normalizeLooseObject(req.body?.placement),
        metadata: this.normalizeLooseObject(req.body?.metadata),
      });
      const saved = await repo.save(workload);
      await this.createOperation({
        tenant,
        workloadId: saved.id,
        type: 'create',
        status: 'succeeded',
        request: { desiredReplicas: saved.desiredReplicas, state: saved.state },
        requestedBy: req.account?.email || null,
      });
      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  };

  updateWorkload = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationWorkload);
      const workload = await this.findWorkloadOrThrow(tenant.id, req.params.id);

      const prevReplicas = workload.desiredReplicas;
      const prevState = workload.state;
      const nextReplicas = req.body?.desiredReplicas !== undefined
        ? this.normalizeReplicas(req.body?.desiredReplicas, workload.desiredReplicas)
        : workload.desiredReplicas;
      const nextState = req.body?.state !== undefined
        ? this.normalizeWorkloadState(req.body?.state, workload.state)
        : workload.state;

      workload.name = req.body?.name ? this.requireString(req.body?.name, 'name', 200) : workload.name;
      workload.image = req.body?.image ? this.requireString(req.body?.image, 'image', 255) : workload.image;
      workload.runtimeType = req.body?.runtimeType
        ? this.normalizeRuntimeType(req.body?.runtimeType, workload.runtimeType)
        : workload.runtimeType;
      workload.desiredReplicas = nextReplicas;
      workload.state = nextState;
      workload.config = req.body?.config !== undefined ? this.normalizeLooseObject(req.body?.config) : workload.config;
      workload.placement =
        req.body?.placement !== undefined ? this.normalizeLooseObject(req.body?.placement) : workload.placement;
      workload.metadata =
        req.body?.metadata !== undefined ? this.normalizeLooseObject(req.body?.metadata) : workload.metadata;
      workload.revision += 1;

      const saved = await repo.save(workload);
      const operationType: OrchestrationOperationType =
        nextState === 'removed' ? 'remove' : nextState === 'stopped' ? 'stop' : nextReplicas !== prevReplicas ? 'scale' : 'update';
      const operationStatus: OrchestrationOperationStatus =
        operationType === 'remove' && prevState === 'removed' ? 'succeeded' : 'pending';

      await this.createOperation({
        tenant,
        workloadId: saved.id,
        type: operationType,
        status: operationStatus,
        request: {
          previous: { desiredReplicas: prevReplicas, state: prevState },
          next: { desiredReplicas: nextReplicas, state: nextState },
        },
        requestedBy: req.account?.email || null,
      });
      res.json(saved);
    } catch (error) {
      next(error);
    }
  };

  removeWorkload = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationWorkload);
      const workload = await this.findWorkloadOrThrow(tenant.id, req.params.id);
      workload.state = 'removed';
      workload.desiredReplicas = 0;
      workload.revision += 1;
      await repo.save(workload);
      await this.createOperation({
        tenant,
        workloadId: workload.id,
        type: 'remove',
        status: 'pending',
        requestedBy: req.account?.email || null,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  listPlacements = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      await this.findWorkloadOrThrow(tenant.id, req.params.id);
      const repo = this.dataSource.getRepository(OrchestrationPlacement);
      const placements = await repo.find({
        where: { tenantId: tenant.id, workloadId: req.params.id },
        relations: ['agent'],
        order: { updatedAt: 'DESC' },
      });
      res.json(placements);
    } catch (error) {
      next(error);
    }
  };

  upsertPlacements = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      await this.findWorkloadOrThrow(tenant.id, req.params.id);
      const rows = Array.isArray(req.body?.placements) ? req.body.placements : [];
      const repo = this.dataSource.getRepository(OrchestrationPlacement);
      const saved: OrchestrationPlacement[] = [];

      for (const row of rows) {
        const agentId = this.normalizeString(row?.agentId, 64);
        const runtimeRef = this.normalizeString(row?.runtimeRef, 255);
        if (!agentId && !runtimeRef) continue;
        const existing = await repo.findOne(
          agentId
            ? { where: { tenantId: tenant.id, workloadId: req.params.id, agentId } }
            : { where: { tenantId: tenant.id, workloadId: req.params.id, agentId: IsNull() } }
        );
        const placementStatus = this.normalizePlacementStatus(row?.status, existing?.status || 'pending');
        const merged = existing
          ? repo.merge(existing, {
              runtimeRef,
              desiredReplicas: this.normalizeReplicas(row?.desiredReplicas, existing.desiredReplicas),
              actualReplicas: this.normalizeReplicas(row?.actualReplicas, existing.actualReplicas),
              status: placementStatus,
              message: this.normalizeString(row?.message, 2000),
              metadata: this.normalizeLooseObject(row?.metadata),
            })
          : repo.create({
              tenant,
              tenantId: tenant.id,
              workloadId: req.params.id,
              agentId: agentId || null,
              runtimeRef,
              desiredReplicas: this.normalizeReplicas(row?.desiredReplicas, 0),
              actualReplicas: this.normalizeReplicas(row?.actualReplicas, 0),
              status: placementStatus,
              message: this.normalizeString(row?.message, 2000),
              metadata: this.normalizeLooseObject(row?.metadata),
            });
        saved.push(await repo.save(merged));
      }
      res.json(saved);
    } catch (error) {
      next(error);
    }
  };

  listOperations = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      const tenant = this.ensureTenant(req);
      const repo = this.dataSource.getRepository(OrchestrationOperation);
      const limit = this.normalizeReplicas(req.query.limit, 100);
      const where: Record<string, unknown> = { tenantId: tenant.id };
      if (typeof req.query.workloadId === 'string' && req.query.workloadId.trim()) {
        where.workloadId = req.query.workloadId.trim();
      }
      const rows = await repo.find({
        where,
        order: { createdAt: 'DESC' },
        take: Math.max(1, Math.min(limit, 500)),
      });
      res.json(rows);
    } catch (error) {
      next(error);
    }
  };

  private async createOperation(input: {
    tenant: Tenant;
    workloadId?: string | null;
    type: OrchestrationOperationType;
    status: OrchestrationOperationStatus;
    request?: Record<string, unknown>;
    requestedBy?: string | null;
  }) {
    if (!VALID_OPERATION_TYPES.has(input.type)) return;
    const repo = this.dataSource.getRepository(OrchestrationOperation);
    const operation = repo.create({
      tenant: input.tenant,
      tenantId: input.tenant.id,
      workloadId: input.workloadId || null,
      type: input.type,
      status: input.status,
      request: input.request || null,
      requestedBy: input.requestedBy || null,
    });
    await repo.save(operation);
  }

  private async findWorkloadOrThrow(tenantId: string, workloadId: string) {
    const repo = this.dataSource.getRepository(OrchestrationWorkload);
    const workload = await repo.findOne({ where: { id: workloadId, tenantId } });
    if (!workload) {
      throw new AppError('Workload not found', 404);
    }
    return workload;
  }

  private ensureTenant(req: TenantRequest) {
    if (!req.tenant) throw new AppError('Tenant required', 400);
    return req.tenant;
  }

  private normalizeRuntimeType(raw: unknown, fallback: 'docker' | 'k8s') {
    const value = this.normalizeString(raw, 16) || fallback;
    if (!VALID_RUNTIME_TYPES.has(value)) throw new AppError('Invalid runtimeType', 400);
    return value as 'docker' | 'k8s';
  }

  private normalizeWorkloadState(raw: unknown, fallback: OrchestrationWorkloadState) {
    const value = this.normalizeString(raw, 24) || fallback;
    if (!VALID_WORKLOAD_STATES.has(value as OrchestrationWorkloadState)) {
      throw new AppError('Invalid state', 400);
    }
    return value as OrchestrationWorkloadState;
  }

  private normalizeAgentStatus(raw: unknown, fallback: OrchestrationAgentStatus) {
    const value = this.normalizeString(raw, 24) || fallback;
    if (!VALID_AGENT_STATUSES.has(value as OrchestrationAgentStatus)) {
      throw new AppError('Invalid status', 400);
    }
    return value as OrchestrationAgentStatus;
  }

  private normalizePlacementStatus(raw: unknown, fallback: OrchestrationPlacementStatus) {
    const value = this.normalizeString(raw, 24) || fallback;
    if (!VALID_PLACEMENT_STATUSES.has(value as OrchestrationPlacementStatus)) {
      throw new AppError('Invalid placement status', 400);
    }
    return value as OrchestrationPlacementStatus;
  }

  private normalizeReplicas(raw: unknown, fallback: number) {
    const num = Number(raw);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(10000, Math.floor(num)));
  }

  private requireString(raw: unknown, field: string, maxLen: number) {
    const value = this.normalizeString(raw, maxLen);
    if (!value) throw new AppError(`${field} is required`, 400);
    return value;
  }

  private normalizeString(raw: unknown, maxLen: number) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    return value.slice(0, maxLen);
  }

  private normalizeStringMap(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const output: Record<string, string> = {};
    Object.entries(raw).forEach(([key, value]) => {
      const safeKey = this.normalizeString(key, 128);
      if (!safeKey) return;
      output[safeKey] = String(value ?? '');
    });
    return output;
  }

  private normalizeCapacity(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const output: Record<string, string | number | boolean> = {};
    Object.entries(raw).forEach(([key, value]) => {
      const safeKey = this.normalizeString(key, 128);
      if (!safeKey) return;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        output[safeKey] = value;
      }
    });
    return output;
  }

  private normalizeLooseObject(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  }
}
