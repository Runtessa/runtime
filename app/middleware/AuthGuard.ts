import { NextFunction, Response } from "express";
import { DataSource } from "typeorm";
import { AppError } from "../../common/AppError";
import { CryptoService } from "../../core/security/CryptoService";
import { Account } from '@idp/shared';
import { TenantRequest } from "../../types/RequestContext";

export interface AuthGuardOptions {
  publicPaths?: RegExp[];
}

export const AuthGuard =
  (dataSource: DataSource, cryptoService: CryptoService) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError("Tenant context missing", 400);
      }
      const header = req.headers["authorization"];
      const hasBearer =
        typeof header === "string" && header.toLowerCase().startsWith("bearer ");

      let payload = null as ReturnType<typeof cryptoService.verifyToken> | null;
      if (!hasBearer) {
        return res.status(401).json({ error: "Authorization header missing" });
      }

      const token = header.substring(7);
      payload = cryptoService.verifyToken(token);
      if (!payload || payload.tenantId !== req.tenant.id) {
        return res.status(401).json({ error: "Invalid token" });
      }

      req.tokenPayload = payload;
      const accountRepo = dataSource.getRepository(Account);
      const account = await accountRepo.findOne({
        where: { id: payload.sub },
        relations: ["tenant"],
      });

      if (!account || account.tenant.id !== req.tenant.id) {
        return res.status(403).json({ error: "Account not part of tenant" });
      }

      req.account = account;

      next();
    } catch (error) {
      next(error);
    }
  };

export const OptionalAuthGuard =
  (dataSource: DataSource, cryptoService: CryptoService) =>
  async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError("Tenant context missing", 400);
      }
      const header = req.headers["authorization"];
      const hasBearer =
        typeof header === "string" && header.toLowerCase().startsWith("bearer ");

      if (!hasBearer) {
        return next();
      }

      const token = header.substring(7);
      const payload = cryptoService.verifyToken(token);
      if (!payload || payload.tenantId !== req.tenant.id) {
        return res.status(401).json({ error: "Invalid token" });
      }

      req.tokenPayload = payload;
      const accountRepo = dataSource.getRepository(Account);
      const account = await accountRepo.findOne({
        where: { id: payload.sub },
        relations: ["tenant"],
      });

      if (!account || account.tenant.id !== req.tenant.id) {
        return res.status(403).json({ error: "Account not part of tenant" });
      }

      req.account = account;
      next();
    } catch (error) {
      next(error);
    }
  };
