import { AppError } from "../../common/AppError";
import { TenantRequest } from "../../types/RequestContext";
import { CryptoService } from "./CryptoService";
import { asObject, normalizeSecretValue, readTenantSecretValue } from "./ssoPrimitives";
import type { TenantSsoConfig } from "./ssoTypes";

export const resolveTenantSsoConfig = async (
  tenantReq: TenantRequest,
  cryptoService: CryptoService,
  defaults: { authBaseUrl: string; scope: string }
): Promise<TenantSsoConfig> => {
  if (!tenantReq.tenant) {
    throw new AppError("Tenant required", 400);
  }

  const adapterConfig = asObject(tenantReq.tenant.adapterConfig);
  const authBlock = asObject(adapterConfig.auth);
  const ssoBlock = {
    ...asObject(adapterConfig.sso),
    ...asObject(authBlock.sso),
  };

  const authBaseUrl =
    normalizeSecretValue(String(ssoBlock.authBaseUrl || ssoBlock.auth_base_url || "")) ||
    defaults.authBaseUrl;
  if (!authBaseUrl) {
    throw new AppError(
      "SSO auth base URL is missing. Set CORE_SSO_AUTH_BASE_URL or tenant sso.authBaseUrl",
      500
    );
  }

  const clientIdSecretKey =
    normalizeSecretValue(
      String(
        ssoBlock.clientIdSecretKey ||
          ssoBlock.client_id_secret_key ||
          ssoBlock.oauthClientIdSecretKey ||
          "auth:sso:client_id"
      )
    ) || "auth:sso:client_id";
  const clientSecretSecretKey =
    normalizeSecretValue(
      String(
        ssoBlock.clientSecretSecretKey ||
          ssoBlock.client_secret_secret_key ||
          ssoBlock.oauthClientSecretSecretKey ||
          "auth:sso:client_secret"
      )
    ) || "auth:sso:client_secret";
  const tenantTokenSecretKey =
    normalizeSecretValue(
      String(
        ssoBlock.tenantTokenSecretKey ||
          ssoBlock.tenant_token_secret_key ||
          ssoBlock.tenantSsoTokenSecretKey ||
          "auth:sso:tenant_token"
      )
    ) || "auth:sso:tenant_token";

  const clientIdFromSecret = await readTenantSecretValue(
    tenantReq,
    cryptoService,
    clientIdSecretKey
  );
  const clientSecretFromSecret = await readTenantSecretValue(
    tenantReq,
    cryptoService,
    clientSecretSecretKey
  );
  const tenantTokenFromSecret = await readTenantSecretValue(
    tenantReq,
    cryptoService,
    tenantTokenSecretKey
  );

  const clientId = normalizeSecretValue(clientIdFromSecret);
  const clientSecret = normalizeSecretValue(clientSecretFromSecret);
  const tenantSsoToken = normalizeSecretValue(tenantTokenFromSecret);
  const scope = normalizeSecretValue(String(ssoBlock.scope || "")) || defaults.scope;

  if (!clientId || !clientSecret) {
    throw new AppError(
      `Tenant SSO client credentials are missing for ${tenantReq.tenant.hostname}. Store them in tenant secrets (${clientIdSecretKey}, ${clientSecretSecretKey}).`,
      500
    );
  }
  if (!tenantSsoToken) {
    throw new AppError(
      `Tenant SSO token is missing for ${tenantReq.tenant.hostname}. Store it in tenant secret ${tenantTokenSecretKey}.`,
      500
    );
  }

  return {
    authBaseUrl,
    clientId,
    clientSecret,
    scope,
    tenantSsoToken,
  };
};
