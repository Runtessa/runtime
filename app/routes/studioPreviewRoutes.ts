import type { Express, RequestHandler } from "express";
import type { DataSource } from "typeorm";
import { Tenant } from "@idp/shared";
import { CryptoService } from "../../core/security/CryptoService";
import { createCoreAdminGuard } from "../security/coreHttpSecurity";

export const STUDIO_PREVIEW_TTL_SECONDS = 600;

export function registerStudioPreviewRoutes(
  app: Express,
  dataSource: DataSource,
  cryptoService: CryptoService,
) {
  const guard = createCoreAdminGuard(
    () => process.env.CORE_STUDIO_PREVIEW_TOKEN,
  );
  const issue: RequestHandler = async (req, res, next) => {
    try {
      const { tenantId, actor } = req.body || {};
      if (
        typeof tenantId !== "string" ||
        !actor ||
        typeof actor.id !== "string" ||
        !actor.id.trim() ||
        actor.id.length > 200 ||
        typeof actor.email !== "string" ||
        actor.email.length > 320 ||
        !["ADMIN", "USER"].includes(actor.role)
      ) {
        res.status(400).json({ error: "Invalid preview identity" });
        return;
      }
      const tenant = await dataSource
        .getRepository(Tenant)
        .findOne({ where: { id: tenantId } });
      if (!tenant || tenant.isSuspended) {
        res.status(403).json({ error: "Preview tenant is unavailable" });
        return;
      }
      const token = cryptoService.signToken(
        {
          sub: actor.id,
          tenantId: tenant.id,
          role: actor.role,
          metadata: {
            purpose: "studio-preview",
            previewRead: true,
            email: actor.email,
          },
        },
        STUDIO_PREVIEW_TTL_SECONDS,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({
        token,
        tenantHost: tenant.hostname,
        expiresAt: Date.now() + STUDIO_PREVIEW_TTL_SECONDS * 1000,
      });
    } catch (error) {
      next(error);
    }
  };
  app.post("/auth/studio-preview", guard, issue);
}
