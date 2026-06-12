import assert from "assert";
import {
  materializeVirtualPackageSource,
  repairUiCompiledSource,
  resolveDraftRuntimeSource,
} from "../app/registry/registrySource";

const virtualPackage = JSON.stringify({
  entryPath: "src/index.tsx",
  files: [
    {
      path: "src/ignored.tsx",
      content: "export const Ignored = () => null;",
    },
    {
      path: "src/index.tsx",
      content: "export default function Hello(){ return <div>Hello</div>; }",
    },
  ],
});

const materialized = materializeVirtualPackageSource(virtualPackage, "jsx");
assert(materialized);
assert(materialized!.includes("exports"));
assert(materialized!.includes("Hello"));
assert(!materialized!.includes("Ignored"));

assert.equal(materializeVirtualPackageSource("not json", "jsx"), null);
assert.equal(materializeVirtualPackageSource(JSON.stringify({ files: [] }), "jsx"), null);

const repaired = repairUiCompiledSource("tenant/hello-widget", "function HelloWidget() { return null; }", "js");
assert(repaired.includes("exports.default = HelloWidget"));
assert(repaired.includes("exports.HelloWidget = HelloWidget"));

const alreadyExporting = repairUiCompiledSource("tenant/hello-widget", "exports.default = function HelloWidget(){};", "js");
assert.equal(alreadyExporting, "exports.default = function HelloWidget(){};");

const idpPackage = repairUiCompiledSource("@idp/runtime", "function Runtime(){}", "js");
assert.equal(idpPackage, "function Runtime(){}");

const cssSource = resolveDraftRuntimeSource({
  name: "tenant/styles",
  fileExtension: "css",
  sourceCode: { code: ".root { color: red; }" },
} as any, "compiled-css", true);
assert.equal(cssSource, ".root { color: red; }");

const fallbackSource = resolveDraftRuntimeSource({
  name: "tenant/fallback",
  fileExtension: "jsx",
  sourceCode: { code: "" },
} as any, "function Fallback(){}", true);
assert(fallbackSource.includes("exports.default = Fallback"));

console.log("registry source regression checks passed");
