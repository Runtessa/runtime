import { AppError } from "../../common/AppError";

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "admin",
  "api",
  "auth",
  "www",
]);

export type TenantResourceConfig = {
  memory: number;
  timeout: number;
};

export const DEFAULT_TENANT_RESOURCE_CONFIG: TenantResourceConfig = {
  memory: 512,
  timeout: 5_000,
};

const RESOURCE_LIMITS = {
  memory: { min: 128, max: 4096 },
  timeout: { min: 1_000, max: 30_000 },
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const parseBoundedNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(Math.trunc(parsed), min, max);
};

export const normalizeTenantHostname = (hostname: unknown) => {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!normalized) {
    throw new AppError("hostname is required", 400, "tenant_hostname_required");
  }

  if (normalized.length > 253) {
    throw new AppError("hostname is too long", 400, "tenant_hostname_invalid");
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    throw new AppError("IP addresses are not valid tenant hostnames", 400, "tenant_hostname_invalid");
  }

  if (RESERVED_HOSTNAMES.has(normalized)) {
    throw new AppError("hostname is reserved", 400, "tenant_hostname_reserved");
  }

  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => !HOSTNAME_LABEL.test(label))) {
    throw new AppError("hostname must be a valid DNS hostname", 400, "tenant_hostname_invalid");
  }

  return normalized;
};

export const normalizeTenantResourceConfig = (input: unknown): TenantResourceConfig => {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_TENANT_RESOURCE_CONFIG };
  }

  const record = input as Record<string, unknown>;
  return {
    memory: parseBoundedNumber(
      record.memory,
      DEFAULT_TENANT_RESOURCE_CONFIG.memory,
      RESOURCE_LIMITS.memory.min,
      RESOURCE_LIMITS.memory.max
    ),
    timeout: parseBoundedNumber(
      record.timeout,
      DEFAULT_TENANT_RESOURCE_CONFIG.timeout,
      RESOURCE_LIMITS.timeout.min,
      RESOURCE_LIMITS.timeout.max
    ),
  };
};
