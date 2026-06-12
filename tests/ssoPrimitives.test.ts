import assert from "assert";
import { requestOrigin, safeReturnTo } from "../core/security/ssoPrimitives";

const makeReq = (options: {
  headers?: Record<string, string>;
  protocol?: string;
  host?: string;
  trustProxy?: boolean;
}) => {
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    headers,
    protocol: options.protocol || "http",
    get: (name: string) => (name.toLowerCase() === "host" ? options.host : headers[name.toLowerCase()]),
    app: {
      get: (name: string) => (name === "trust proxy" ? Boolean(options.trustProxy) : undefined),
    },
  };
};

assert.equal(safeReturnTo("/dashboard", "/"), "/dashboard");
assert.equal(safeReturnTo("https://evil.example.com", "/"), "/");
assert.equal(safeReturnTo("//evil.example.com", "/"), "/");
assert.equal(safeReturnTo("", "/fallback"), "/fallback");

assert.equal(
  requestOrigin(
    makeReq({
      protocol: "http",
      host: "tenant.example.com",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "spoofed.example.com",
      },
      trustProxy: false,
    }) as any
  ),
  "http://tenant.example.com"
);

assert.equal(
  requestOrigin(
    makeReq({
      protocol: "http",
      host: "internal:3005",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "tenant.example.com",
      },
      trustProxy: true,
    }) as any
  ),
  "https://tenant.example.com"
);

assert.equal(
  requestOrigin(
    makeReq({
      protocol: "https",
      host: "tenant.example.com",
      headers: {
        "x-forwarded-proto": "https,http",
        "x-forwarded-host": "tenant.example.com,internal",
      },
      trustProxy: true,
    }) as any
  ),
  "https://tenant.example.com"
);

console.log("SSO primitive regression checks passed");
