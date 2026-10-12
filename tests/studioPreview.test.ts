import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "node:crypto";
import { CryptoService } from "../core/security/CryptoService";
import { AuthGuard, OptionalAuthGuard } from "../app/middleware/AuthGuard";
import { registerStudioPreviewRoutes } from "../app/routes/studioPreviewRoutes";
import { coreErrorHandler } from "../app/security/errorHandler";

async function main() {
  const crypto = new CryptoService(randomBytes(32), randomBytes(32));
  const dataSource: any = {
    getRepository: () => ({
      findOne: async ({ where }: any) =>
        where.id === "missing"
          ? null
          : {
              id: where.id,
              hostname: "tenant.test",
              isSuspended: where.id === "suspended",
            },
    }),
  };
  const app = express();
  app.use(express.json());
  registerStudioPreviewRoutes(app, dataSource, crypto);
  app.use(coreErrorHandler);
  const before = process.env.CORE_STUDIO_PREVIEW_TOKEN;
  process.env.CORE_STUDIO_PREVIEW_TOKEN = "issuer-secret";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address() as { port: number };
    const issue = (tenantId: string, token = "issuer-secret", role = "ADMIN") =>
      fetch(`http://127.0.0.1:${address.port}/auth/studio-preview`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId,
          actor: { id: "studio:1", email: "owner@example.test", role },
        }),
      });
    assert.equal((await issue("tenant-a", "wrong")).status, 401);
    assert.equal((await issue("missing")).status, 403);
    assert.equal((await issue("suspended")).status, 403);
    assert.equal(
      (await issue("tenant-a", "issuer-secret", "SUPERUSER")).status,
      400,
    );
    const response = await issue("tenant-a");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { token } = (await response.json()) as { token: string };
    const payload = crypto.verifyToken(token)!;
    assert.equal(payload.sub, "studio:1");
    assert.equal(payload.tenantId, "tenant-a");
    assert.equal(payload.metadata?.purpose, "studio-preview");
    const reader = await issue("tenant-a", "issuer-secret", "USER");
    assert.equal(reader.status, 200);
    const readerPayload = crypto.verifyToken(
      ((await reader.json()) as { token: string }).token,
    )!;
    assert.equal(
      readerPayload.role,
      "USER",
      "preview read access does not elevate application role",
    );
    assert.equal(readerPayload.metadata?.previewRead, true);
    assert(payload.exp <= Math.floor(Date.now() / 1000) + 600);
    for (const factory of [AuthGuard, OptionalAuthGuard]) {
      for (const [tenantId, allow, expected] of [
        ["tenant-a", false, 403],
        ["tenant-a", true, 200],
        ["tenant-b", true, 401],
      ] as const) {
        let status = 200;
        let passed = false;
        const req: any = {
          headers: { authorization: `Bearer ${token}` },
          tenant: { id: tenantId },
        };
        const res: any = {
          status: (code: number) => {
            status = code;
            return res;
          },
          json: () => res,
        };
        await factory(dataSource, crypto, { allowStudioPreview: allow })(
          req,
          res,
          () => {
            passed = true;
          },
        );
        assert.equal(status, expected);
        assert.equal(passed, expected === 200);
      }
    }
    delete process.env.CORE_STUDIO_PREVIEW_TOKEN;
    assert.equal((await issue("tenant-a")).status, 503);
  } finally {
    if (before === undefined) delete process.env.CORE_STUDIO_PREVIEW_TOKEN;
    else process.env.CORE_STUDIO_PREVIEW_TOKEN = before;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  console.log(
    "Preview credentials are tenant scoped, short lived, and rejected by management guards.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
