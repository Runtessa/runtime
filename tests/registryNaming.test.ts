import assert from "assert";
import {
  buildCatalogAliases,
  buildGlobalLookupNames,
  buildTenantLookupNames,
  normalizeRequestedName,
  registryCacheKey,
} from "../app/registry/registryNaming";

assert.equal(normalizeRequestedName(undefined), "");
assert.equal(normalizeRequestedName("  /foo/bar/  "), "foo/bar");
assert.equal(normalizeRequestedName("%2540shared%252Fbutton"), "@shared/button");
assert.equal(normalizeRequestedName("foo\\bar"), "foo/bar");

assert.deepEqual(buildGlobalLookupNames("button"), ["button", "@shared/button"]);
assert.deepEqual(buildGlobalLookupNames("@shared/button"), ["@shared/button", "button"]);
assert.deepEqual(buildGlobalLookupNames("@scope/button"), ["@scope/button"]);

assert.deepEqual(buildTenantLookupNames("button"), ["button"]);
assert.deepEqual(buildTenantLookupNames("@shared/button"), ["@shared/button", "button"]);

assert.deepEqual(buildCatalogAliases("button", "global"), ["button", "@shared/button"]);
assert.deepEqual(buildCatalogAliases("@shared/button", "tenant"), ["@shared/button", "button"]);

assert.equal(
  registryCacheKey("tenant", "tenant-1", "@shared/button", "latest"),
  "registry:tenant:tenant-1:%40shared%2Fbutton:latest"
);
assert.equal(
  registryCacheKey("global", undefined, "button", "1.0.0"),
  "registry:global:button:1.0.0"
);

console.log("registry naming regression checks passed");
