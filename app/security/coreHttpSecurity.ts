import cors from "cors";
import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../../common/AppError";

export const parseAllowedOrigins = (value: string | undefined) =>
  new Set(
    (value || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );

export const isLocalDevelopmentOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

export const isOriginAllowed = (
  origin: string | undefined,
  allowedOrigins: Set<string>,
  isDevelopmentEnv: boolean
) => {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.has(origin)) {
    return true;
  }

  return isDevelopmentEnv && isLocalDevelopmentOrigin(origin);
};

export const createCoreCors = (options: {
  allowedOrigins: Set<string>;
  isDevelopmentEnv: boolean;
}) =>
  cors({
    credentials: true,
    origin: (origin, callback) => {
      return callback(
        null,
        isOriginAllowed(origin, options.allowedOrigins, options.isDevelopmentEnv)
      );
    },
  });

export const secureTokenEquals = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export const readAdminToken = (req: Request) => {
  const authorization = req.get("authorization") || "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || String(req.get("x-core-admin-token") || "").trim();
};

export const createCoreAdminGuard = (readExpectedToken: () => string | undefined) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const expectedToken = String(readExpectedToken() || "").trim();
    if (!expectedToken) {
      return next(
        new AppError("Core admin API is not configured", 503, "core_admin_not_configured")
      );
    }

    const actualToken = readAdminToken(req);
    if (!actualToken || !secureTokenEquals(actualToken, expectedToken)) {
      return next(new AppError("Admin authentication required", 401, "admin_auth_required"));
    }

    return next();
  };
};
