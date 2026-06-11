import assert from "assert";
import { AppError } from "../common/AppError";
import {
  DEFAULT_TENANT_RESOURCE_CONFIG,
  normalizeTenantHostname,
  normalizeTenantResourceConfig,
} from "../app/admin/tenantProvisioning";

const assertAppError = (fn: () => unknown, status: number, code: string) => {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof AppError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
};

// Hostname normalization keeps valid public tenant hostnames usable.
assert.equal(normalizeTenantHostname(" Tenant.Example.COM. "), "tenant.example.com");
assert.equal(normalizeTenantHostname("app-1.example.co"), "app-1.example.co");

// Admin provisioning must reject empty, reserved, IP, and malformed hostnames.
assertAppError(() => normalizeTenantHostname(""), 400, "tenant_hostname_required");
assertAppError(() => normalizeTenantHostname("localhost"), 400, "tenant_hostname_reserved");
assertAppError(() => normalizeTenantHostname("127.0.0.1"), 400, "tenant_hostname_invalid");
assertAppError(() => normalizeTenantHostname("bad_host.example.com"), 400, "tenant_hostname_invalid");
assertAppError(() => normalizeTenantHostname("singlelabel"), 400, "tenant_hostname_invalid");

// Missing resource config uses safe defaults.
assert.deepEqual(normalizeTenantResourceConfig(undefined), DEFAULT_TENANT_RESOURCE_CONFIG);

// Resource config is bounded to prevent abusive provisioning values.
assert.deepEqual(normalizeTenantResourceConfig({ memory: 64, timeout: 100 }), {
  memory: 128,
  timeout: 1_000,
});
assert.deepEqual(normalizeTenantResourceConfig({ memory: 999999, timeout: 999999 }), {
  memory: 4096,
  timeout: 30_000,
});
assert.deepEqual(normalizeTenantResourceConfig({ memory: 1024.8, timeout: 10_500.9 }), {
  memory: 1024,
  timeout: 10_500,
});
assert.deepEqual(normalizeTenantResourceConfig({ memory: "bad", timeout: "bad" }), DEFAULT_TENANT_RESOURCE_CONFIG);

console.log("tenant provisioning regression checks passed");
