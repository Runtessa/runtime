import assert from 'node:assert/strict';
import { isDeveloperAccess } from '../common/devAccess';
import { ApiRouter } from '../app/routers/api';

const request = (role = 'DEVELOPER', headers = {}): any => ({
  headers, tenant: { id: 'tenant-a' }, account: { role },
  tokenPayload: { tenantId: 'tenant-a', role },
});

assert.equal(isDeveloperAccess({ headers: { 'x-dev-preview': 'true' } } as any), false);
assert.equal(isDeveloperAccess({ ...request(), account: undefined }), false);
assert.equal(isDeveloperAccess({ ...request(), tokenPayload: undefined }), false);
assert.equal(isDeveloperAccess({ ...request(), tokenPayload: { tenantId: 'tenant-b', role: 'ADMIN' } }), false);
assert.equal(isDeveloperAccess(request('USER', { 'x-dev-preview': 'true' })), false);
assert.equal(isDeveloperAccess(request('DEVELOPER')), true);
assert.equal(isDeveloperAccess(request('ADMIN', { 'x-dev-preview': 'true' })), true);
assert.equal(isDeveloperAccess(request('ADMIN', { 'x-dev-preview': 'false' })), false);
const previewReader = request('USER', { 'x-dev-preview': 'true' });
previewReader.tokenPayload.metadata = { purpose: 'studio-preview', previewRead: true };
assert.equal(isDeveloperAccess(previewReader), true);
previewReader.headers['x-dev-preview'] = 'false';
assert.equal(isDeveloperAccess(previewReader), false);
previewReader.headers['x-dev-preview'] = 'true';
previewReader.tokenPayload.metadata.previewRead = false;
assert.equal(isDeveloperAccess(previewReader), false);

// Verify the real registry route stacks authenticate before consulting draft access.
const noOp = (_req: any, _res: any, next: any) => next();
const controller = new Proxy({}, { get: () => noOp });
let authenticated = 0;
const router: any = ApiRouter(noOp, noOp, noOp, controller as any, controller as any,
  controller as any, controller as any, controller as any, (_req: any, _res: any, next: any) => {
    authenticated++; next();
  });
for (const path of ['/registry-catalog', '/registry-tenant-catalog', '/registry/*', '/registry-tenant/*']) {
  const route = router.stack.find((layer: any) => layer.route?.path === path).route;
  let reached = false;
  route.stack[1].handle({ tenant: { id: 'tenant-a' } }, {}, () => { reached = true; });
  assert.equal(reached, true);
}
assert.equal(authenticated, 4);
const route = router.stack.find((layer: any) => layer.route?.path === '/registry/*').route;
route.stack[1].handle({}, {}, () => {});
assert.equal(authenticated, 4, 'tenantless published catalog remains publicly reachable');
console.log('Developer preview authorization and registry authentication checks passed.');
