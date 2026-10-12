import { transformSync } from "esbuild";

type UiPackageLike = {
  name: string;
  entryPath?: string | null;
  fileExtension?: string | null;
  sourceCode?: { code?: string | null } | null;
};

type EsbuildLoader = "js" | "jsx" | "ts" | "tsx";

export const materializeVirtualPackageSource = (
  source: string,
  fileExtension?: string | null
) => {
  const raw = String(source || "").trim();
  if (!raw || raw[0] !== "{") return null;

  try {
    const parsed = JSON.parse(raw) as {
      entryPath?: unknown;
      files?: Array<{
        path?: unknown;
        fileExtension?: unknown;
        content?: unknown;
      }>;
    };
    if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) return null;

    const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const pickLoader = (pathValue: string, extHint?: string | null): EsbuildLoader => {
      const fromPath = pathValue.includes(".") ? pathValue.split(".").pop() || "" : "";
      const ext = String(fromPath || extHint || "")
        .trim()
        .toLowerCase();
      if (ext === "ts") return "ts";
      if (ext === "tsx") return "tsx";
      if (ext === "js") return "js";
      if (ext === "jsx") return "jsx";
      return "jsx";
    };

    const entries = parsed.files
      .map((file) => {
        const pathValue = typeof file?.path === "string" ? normalizePath(file.path) : "";
        const content = typeof file?.content === "string" ? file.content : "";
        if (!pathValue || !content) return null;
        const loader = pickLoader(
          pathValue,
          typeof file?.fileExtension === "string" ? file.fileExtension : fileExtension
        );
        return { path: pathValue, content, loader };
      })
      .filter(Boolean) as Array<{ path: string; content: string; loader: EsbuildLoader }>;
    if (entries.length === 0) return null;

    const entryHint =
      typeof parsed.entryPath === "string" && parsed.entryPath.trim()
        ? normalizePath(parsed.entryPath)
        : "";
    const preferred = [
      entryHint,
      "src/index.tsx",
      "src/index.ts",
      "src/index.jsx",
      "src/index.js",
      "index.tsx",
      "index.ts",
      "index.jsx",
      "index.js",
    ].filter(Boolean);

    let entry = entries[0];
    for (const candidate of preferred) {
      const found = entries.find((item) => item.path === candidate);
      if (found) {
        entry = found;
        break;
      }
    }

    const transformed = transformSync(entry.content, {
      loader: entry.loader,
      format: "cjs",
      target: "es2019",
      sourcemap: false,
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    const code = String(transformed.code || "").trim();
    return code || null;
  } catch {
    return null;
  }
};

export const repairUiCompiledSource = (
  name: string,
  source: string,
  fileExtension?: string | null
) => {
  const ext = String(fileExtension || "").trim().toLowerCase();
  if (ext !== "js" && ext !== "jsx") return source;
  if (!source || typeof source !== "string") return source;

  const materialized = materializeVirtualPackageSource(source, ext) || source;
  if (name.startsWith("@idp/") || name.startsWith("idp/")) return materialized;

  const hasAnyExports =
    materialized.includes("exports.") ||
    materialized.includes("module.exports") ||
    materialized.includes("Object.defineProperty(exports");
  if (hasAnyExports) return materialized;

  const pkgTail = name.split("/").pop() || name;
  const inferred = pkgTail
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  if (!inferred) return materialized;

  const declared =
    new RegExp(`\\bfunction\\s+${inferred}\\b`).test(materialized) ||
    new RegExp(`\\b(?:var|let|const|class)\\s+${inferred}\\b`).test(materialized);
  if (!declared) return materialized;

  const patch = `
;try {
  if (typeof ${inferred} !== 'undefined') {
    if (typeof exports === 'object' && exports) {
      if (typeof exports.default === 'undefined') exports.default = ${inferred};
      if (typeof exports.${inferred} === 'undefined') exports.${inferred} = ${inferred};
    }
  }
} catch (e) {}
`;
  return `${materialized}\n${patch}`;
};

export const resolveDraftRuntimeSource = (
  pkg: UiPackageLike,
  compiled: string,
  preferSource: boolean
) => {
  // Shared projects compile their entrypoint together with local modules and
  // styles. Recompiling only the entry source discards those bundled files.
  if (pkg.entryPath && compiled.trim()) {
    return repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
  }
  if (!preferSource) {
    return repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
  }

  const sourceCode = pkg.sourceCode?.code;
  if (!sourceCode || typeof sourceCode !== "string" || !sourceCode.trim()) {
    return repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
  }

  const ext = String(pkg.fileExtension || "").trim().toLowerCase();
  if (ext === "css" || ext === "json") {
    return sourceCode;
  }

  const loader = ext === "js" || ext === "jsx" || ext === "ts" || ext === "tsx" ? ext : "jsx";
  const sourcefile = pkg.name && String(pkg.name).includes(".") ? String(pkg.name) : `${pkg.name}.${loader}`;

  try {
    const transformed = transformSync(sourceCode, {
      loader: loader as EsbuildLoader,
      format: "cjs",
      target: "es2019",
      sourcemap: "inline",
      sourcefile,
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    const code = String(transformed.code || "").trim();
    if (!code) {
      return repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
    }
    return repairUiCompiledSource(pkg.name, code, pkg.fileExtension);
  } catch {
    return repairUiCompiledSource(pkg.name, compiled, pkg.fileExtension);
  }
};
