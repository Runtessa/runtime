import { createHash, randomBytes } from "crypto";
import { Request } from "express";
import { Secret } from "@idp/shared";
import { AppError } from "../../common/AppError";
import { AppDataSource } from "../datasource";
import { TenantRequest } from "../../types/RequestContext";
import { CryptoService } from "./CryptoService";

export const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const normalizeSecretValue = (value: string | null | undefined): string | null => {
  const text = String(value || "").trim();
  return text || null;
};

export const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

export const normalizeRoleValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((item) => {
      if (typeof item === "string") return item;
      const obj = asObject(item);
      return String(obj.role_code || obj.roleCode || obj.code || obj.role || obj.name || "");
    })
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(out));
};

export const normalizeOrganizations = (
  value: unknown
): Array<{ randId: string; code: string | null; name: string | null }> => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ randId: string; code: string | null; name: string | null }> = [];
  for (const item of value) {
    const obj = asObject(item);
    const randId = String(obj.org_rand_id || obj.orgRandId || "").trim();
    if (!randId) continue;
    const code = normalizeSecretValue(String(obj.org_code || obj.orgCode || ""));
    const name = normalizeSecretValue(String(obj.org_name || obj.orgName || ""));
    out.push({ randId, code, name });
  }
  return out;
};

export const safeReturnTo = (input: unknown, fallback = "/"): string => {
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
};

export const requestOrigin = (req: Request): string => {
  const trustsProxyHeaders = Boolean(req.app?.get?.("trust proxy"));
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    ?.trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    ?.trim();
  const protocol = (trustsProxyHeaders && forwardedProto) || req.protocol || "http";
  const host = (trustsProxyHeaders && forwardedHost) || req.get("host") || "localhost";
  return `${protocol}://${host}`;
};

export const createPkcePair = () => {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
};

export const readTenantSecretValue = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  keyName: string
): Promise<string | null> => {
  if (!tenantReq.tenant || !keyName.trim()) return null;
  const secretRepo = AppDataSource.getRepository(Secret);
  const secret = await secretRepo.findOne({
    where: {
      tenant: { id: tenantReq.tenant.id },
      keyName: keyName.trim(),
    },
  });
  if (!secret) return null;
  try {
    return cryptoService.decryptSecret({
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      authTag: secret.authTag,
    });
  } catch {
    throw new AppError(`Tenant secret ${keyName} failed to decrypt`, 500);
  }
};
