import assert from "assert";
import { AppError } from "../common/AppError";
import {
  createCoreAdminGuard,
  isOriginAllowed,
  parseAllowedOrigins,
  readAdminToken,
  secureTokenEquals,
} from "../app/security/coreHttpSecurity";

const makeReq = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()],
});

const runGuard = (expectedToken: string | undefined, actualHeaders: Record<string, string>) => {
  const guard = createCoreAdminGuard(() => expectedToken);
  let receivedError: unknown;
  let passed = false;
  guard(makeReq(actualHeaders) as any, {} as any, (error?: unknown) => {
    if (error) {
      receivedError = error;
      return;
    }
    passed = true;
  });
  return { passed, error: receivedError };
};

const assertAppError = (error: unknown, status: number, code: string) => {
  assert(error instanceof AppError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
};

// CORS origin policy: explicit allowlist in production, localhost only in dev.
const allowed = parseAllowedOrigins("https://ide.example.com, https://auth.example.com ");
assert.equal(isOriginAllowed(undefined, allowed, false), true);
assert.equal(isOriginAllowed("https://ide.example.com", allowed, false), true);
assert.equal(isOriginAllowed("https://evil.example.com", allowed, false), false);
assert.equal(isOriginAllowed("http://localhost:3002", allowed, true), true);
assert.equal(isOriginAllowed("http://localhost:3002", allowed, false), false);

// Admin token extraction supports Bearer and legacy x-core-admin-token.
assert.equal(
  readAdminToken(makeReq({ authorization: "Bearer secret-token" }) as any),
  "secret-token"
);
assert.equal(
  readAdminToken(makeReq({ "x-core-admin-token": "legacy-token" }) as any),
  "legacy-token"
);

// Constant-time token equality wrapper should reject missing/different length tokens.
assert.equal(secureTokenEquals("same", "same"), true);
assert.equal(secureTokenEquals("same", "diff"), false);
assert.equal(secureTokenEquals("short", "much-longer"), false);

// Admin guard fails closed when not configured.
let result = runGuard(undefined, { authorization: "Bearer any" });
assert.equal(result.passed, false);
assertAppError(result.error, 503, "core_admin_not_configured");

// Admin guard rejects missing/wrong tokens.
result = runGuard("expected", {});
assert.equal(result.passed, false);
assertAppError(result.error, 401, "admin_auth_required");

result = runGuard("expected", { authorization: "Bearer wrong" });
assert.equal(result.passed, false);
assertAppError(result.error, 401, "admin_auth_required");

// Admin guard accepts the configured token.
result = runGuard("expected", { authorization: "Bearer expected" });
assert.equal(result.passed, true);
assert.equal(result.error, undefined);

console.log("core HTTP security regression checks passed");
