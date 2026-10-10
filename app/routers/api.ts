import { Router } from "express";
import { RegistryController } from "../controllers/RegistryController";
import { ModuleController } from "../controllers/ModuleController";
import { UIEntityController } from "../controllers/UIEntityController";
import { TenantAclController } from "../controllers/TenantAclController";
import { OrchestrationController } from "../controllers/OrchestrationController";

export const ApiRouter = (
  contextMiddleware: any,
  optionalContextMiddleware: any,
  authGuard: any,
  registryController: RegistryController,
  moduleController: ModuleController,
  uiEntityController: UIEntityController,
  tenantAclController: TenantAclController,
  orchestrationController: OrchestrationController,
  optionalAuthGuard: any
) => {
  const router = Router();
  const registryAuth = (req: any, res: any, next: any) =>
    req.tenant ? optionalAuthGuard(req, res, next) : next();

  const decodeSegment = (value?: string) => {
    if (!value) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const isVersionToken = (value: string) =>
    value === "latest" ||
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);

  const normalizeRegistryParams = (req: any, _res: any, next: any) => {
    const raw =
      (req.params && (req.params[0] as string | undefined)) ||
      (req.params && (req.params.name as string | undefined));
    if (!raw) {
      return next();
    }

    const parts = raw.split("/").filter(Boolean);
    let name = raw;
    let version: string | undefined = req.params?.version;

    if (!version && parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (isVersionToken(last)) {
        version = last;
        name = parts.slice(0, -1).join("/");
      }
    }

    req.params = req.params || {};
    req.params.name = decodeSegment(name) ?? name;
    if (version) {
      req.params.version = decodeSegment(version) ?? version;
    }
    return next();
  };

  router.get(
    "/registry-catalog",
    optionalContextMiddleware,
    registryAuth,
    registryController.catalog
  );
  router.get(
    "/registry-tenant-catalog",
    contextMiddleware,
    registryAuth,
    registryController.catalogTenantOnly
  );
  router.get(
    "/registry/*",
    optionalContextMiddleware,
    registryAuth,
    normalizeRegistryParams,
    registryController.resolve
  );
  router.get(
    "/registry-tenant/*",
    contextMiddleware,
    registryAuth,
    normalizeRegistryParams,
    registryController.resolveTenantOnly
  );
  router.get("/modules", contextMiddleware, authGuard, moduleController.list);
  router.get(
    "/modules/:id",
    contextMiddleware,
    authGuard,
    moduleController.getById
  );
  router.get(
    "/modules/:id/versions",
    contextMiddleware,
    authGuard,
    moduleController.listVersions
  );
  router.post(
    "/modules",
    contextMiddleware,
    authGuard,
    moduleController.create
  );
  router.put(
    "/modules/:id",
    contextMiddleware,
    authGuard,
    moduleController.update
  );
  router.post(
    "/modules/:id/publish",
    contextMiddleware,
    authGuard,
    moduleController.publish
  );
  router.post(
    "/modules/:id/rollback/:revisionId",
    contextMiddleware,
    authGuard,
    moduleController.rollback
  );
  router.delete(
    "/modules/:id",
    contextMiddleware,
    authGuard,
    moduleController.remove
  );

  router.get(
    "/ui-entities",
    contextMiddleware,
    authGuard,
    uiEntityController.list
  );
  router.get(
    "/ui-entities/:id",
    contextMiddleware,
    authGuard,
    uiEntityController.getById
  );
  router.get(
    "/ui-entities/:id/versions",
    contextMiddleware,
    authGuard,
    uiEntityController.listVersions
  );
  router.post(
    "/ui-entities",
    contextMiddleware,
    authGuard,
    uiEntityController.create
  );
  router.put(
    "/ui-entities/:id",
    contextMiddleware,
    authGuard,
    uiEntityController.update
  );
  router.post(
    "/ui-entities/:id/publish",
    contextMiddleware,
    authGuard,
    uiEntityController.publish
  );
  router.post(
    "/ui-entities/:id/rollback/:revisionId",
    contextMiddleware,
    authGuard,
    uiEntityController.rollback
  );
  router.delete(
    "/ui-entities/:id",
    contextMiddleware,
    authGuard,
    uiEntityController.remove
  );

  router.get(
    "/acl/config",
    contextMiddleware,
    authGuard,
    tenantAclController.getConfig
  );
  router.put(
    "/acl/config",
    contextMiddleware,
    authGuard,
    tenantAclController.updateConfig
  );

  router.get(
    "/orchestration/agents",
    contextMiddleware,
    authGuard,
    orchestrationController.listAgents
  );
  router.post(
    "/orchestration/agents/heartbeat",
    contextMiddleware,
    authGuard,
    orchestrationController.heartbeatAgent
  );
  router.get(
    "/orchestration/workloads",
    contextMiddleware,
    authGuard,
    orchestrationController.listWorkloads
  );
  router.post(
    "/orchestration/workloads",
    contextMiddleware,
    authGuard,
    orchestrationController.createWorkload
  );
  router.get(
    "/orchestration/workloads/:id",
    contextMiddleware,
    authGuard,
    orchestrationController.getWorkload
  );
  router.patch(
    "/orchestration/workloads/:id",
    contextMiddleware,
    authGuard,
    orchestrationController.updateWorkload
  );
  router.delete(
    "/orchestration/workloads/:id",
    contextMiddleware,
    authGuard,
    orchestrationController.removeWorkload
  );
  router.get(
    "/orchestration/workloads/:id/placements",
    contextMiddleware,
    authGuard,
    orchestrationController.listPlacements
  );
  router.put(
    "/orchestration/workloads/:id/placements",
    contextMiddleware,
    authGuard,
    orchestrationController.upsertPlacements
  );
  router.get(
    "/orchestration/operations",
    contextMiddleware,
    authGuard,
    orchestrationController.listOperations
  );
  return router;
};
