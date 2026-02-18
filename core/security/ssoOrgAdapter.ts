import { Request } from "express";
import { TenantRequest } from "../../types/RequestContext";
import { AppError } from "../../common/AppError";
import { CryptoService } from "./CryptoService";
import {
  asObject,
  normalizeSecretValue,
  readTenantSecretValue,
} from "./ssoPrimitives";
import type { TenantOrgOption, TenantSsoOrgConfig } from "./ssoTypes";

const readTenantSsoBlock = (tenantReq: TenantRequest): Record<string, unknown> => {
  const adapterConfig = asObject(tenantReq.tenant?.adapterConfig);
  const authBlock = asObject(adapterConfig.auth);
  return {
    ...asObject(adapterConfig.sso),
    ...asObject(authBlock.sso),
  };
};

export const parseTenantSsoOrgConfig = (tenantReq: TenantRequest): TenantSsoOrgConfig => {
  const ssoBlock = readTenantSsoBlock(tenantReq);
  const orgIdQueryParamRaw = normalizeSecretValue(
    String(ssoBlock.orgIdQueryParam || ssoBlock.org_id_query_param || "tenant_org_id")
  );
  const orgIdHeaderRaw = normalizeSecretValue(
    String(ssoBlock.orgIdHeader || ssoBlock.org_id_header || "x-tenant-org-id")
  );
  const normalizedOrgIdQueryParam = String(orgIdQueryParamRaw || "tenant_org_id").replace(
    /[^a-zA-Z0-9._-]/g,
    ""
  );
  const normalizedOrgIdHeader = String(orgIdHeaderRaw || "x-tenant-org-id")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return {
    staticOrgRandId: normalizeSecretValue(
      String(
        ssoBlock.orgId ||
          ssoBlock.org_id ||
          ssoBlock.tenantOrgRandId ||
          ssoBlock.tenant_org_rand_id ||
          ""
      )
    ),
    orgIdQueryParam: normalizedOrgIdQueryParam || "tenant_org_id",
    orgIdHeader: normalizedOrgIdHeader || "x-tenant-org-id",
    adapterUrl: normalizeSecretValue(
      String(ssoBlock.orgAdapterUrl || ssoBlock.org_adapter_url || "")
    ),
    adapterTimeoutMs: Math.max(
      300,
      parseInt(
        String(ssoBlock.orgAdapterTimeoutMs || ssoBlock.org_adapter_timeout_ms || "3000"),
        10
      ) || 3000
    ),
    adapterTokenSecretKey: normalizeSecretValue(
      String(ssoBlock.orgAdapterTokenSecretKey || ssoBlock.org_adapter_token_secret_key || "")
    ),
    adapterRequired:
      String(ssoBlock.orgAdapterRequired || ssoBlock.org_adapter_required || "false")
        .trim()
        .toLowerCase() === "true",
  };
};

const parseOrgOptionsFromAdapterPayload = (value: unknown): TenantOrgOption[] => {
  if (!Array.isArray(value)) return [];
  const out: TenantOrgOption[] = [];
  for (const item of value) {
    const obj = asObject(item);
    const orgRandId = normalizeSecretValue(
      String(obj.orgRandId || obj.org_rand_id || obj.id || "")
    );
    if (!orgRandId) continue;
    out.push({
      orgRandId,
      code: normalizeSecretValue(String(obj.code || obj.orgCode || obj.org_code || "")),
      name: normalizeSecretValue(String(obj.name || obj.orgName || obj.org_name || "")),
    });
  }
  return out;
};

export const fetchTenantOrgAdapterPayload = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  returnTo: string
): Promise<{ defaultOrgRandId: string | null; organizations: TenantOrgOption[] }> => {
  const orgConfig = parseTenantSsoOrgConfig(tenantReq);
  if (!orgConfig.adapterUrl) {
    return {
      defaultOrgRandId: orgConfig.staticOrgRandId,
      organizations: [],
    };
  }

  try {
    const url = new URL(orgConfig.adapterUrl);
    url.searchParams.set("tenant_name", tenantReq.tenant?.hostname || "");
    url.searchParams.set("tenant_id", tenantReq.tenant?.id || "");
    url.searchParams.set("return_to", returnTo || "/");

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (orgConfig.adapterTokenSecretKey) {
      const token = await readTenantSecretValue(
        tenantReq,
        cryptoService,
        orgConfig.adapterTokenSecretKey
      );
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), orgConfig.adapterTimeoutMs);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (orgConfig.adapterRequired) {
          throw new AppError(`Tenant org adapter failed (${response.status})`, 503);
        }
        return {
          defaultOrgRandId: orgConfig.staticOrgRandId,
          organizations: [],
        };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const organizations = parseOrgOptionsFromAdapterPayload(payload.organizations);
      const defaultOrgRandId =
        normalizeSecretValue(
          String(
            payload.defaultOrgRandId ||
              payload.default_org_rand_id ||
              payload.orgRandId ||
              payload.org_id ||
              ""
          )
        ) ||
        orgConfig.staticOrgRandId ||
        organizations[0]?.orgRandId ||
        null;

      return {
        defaultOrgRandId,
        organizations,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    if (orgConfig.adapterRequired) {
      throw error;
    }
    return {
      defaultOrgRandId: orgConfig.staticOrgRandId,
      organizations: [],
    };
  }
};

export const resolveTenantOrgIdForSso = async (
  req: Request,
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  returnTo: string
): Promise<string | null> => {
  const orgConfig = parseTenantSsoOrgConfig(tenantReq);
  const queryOrgRandId = normalizeSecretValue(
    String(
      req.query.tenant_org_id || req.query[orgConfig.orgIdQueryParam] || req.query.org_id || ""
    )
  );
  if (queryOrgRandId) return queryOrgRandId;

  const headerOrgRandId = normalizeSecretValue(
    String(req.headers[orgConfig.orgIdHeader] || req.headers["x-tenant-org-id"] || "")
  );
  if (headerOrgRandId) return headerOrgRandId;

  const adapterPayload = await fetchTenantOrgAdapterPayload(tenantReq, cryptoService, returnTo);
  return adapterPayload.defaultOrgRandId || orgConfig.staticOrgRandId || null;
};
