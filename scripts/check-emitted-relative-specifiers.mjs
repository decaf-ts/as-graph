#!/usr/bin/env node
/**
 * Build-pipeline guard (SAA-809, remediated under SAA-816).
 *
 * Every relative module specifier in the emitted runtime output (`lib/cjs`,
 * `lib/esm`) must resolve using Node's own module-resolution algorithm, for the
 * module system that will actually load the emitted file. The dotted-infix
 * fixture filenames (`*.workflow.ts`, owner-directed by SAA-774/SAA-720)
 * regressed once when an older `@decaf-ts/utils` `build-scripts` rewriter left
 * `./manual-log.workflow` unrewritten in `lib/cjs/workflows/index.cjs` and
 * `lib/esm/workflows/index.js`; Node then failed to resolve the `.workflow`
 * infix at load time, so boot seeded zero workflows. Source-level TypeScript
 * tests still passed because TypeScript resolves the specifier itself, so CI
 * did not catch it.
 *
 * SAA-814 found the first revision of this check false-greened: it probed
 * `${base}.cjs`/`${base}.mjs` candidates that Node never infers, so the exact
 * regression (`require("./manual-log.workflow")` with only
 * `manual-log.workflow.cjs` on disk) passed the guard while Node threw
 * MODULE_NOT_FOUND. This revision mirrors Node resolution instead:
 *   - ESM (`*.mjs`, or `*.js` under a `"type": "module"` package): exact path
 *     only, no extension inference and no directory index.
 *   - CJS (`*.cjs`, or `*.js` otherwise): exact path, then `.js`/`.json`/
 *     `.node`, then a directory `index.js`/`index.json`/`index.node`.
 * Node never appends `.cjs` or `.mjs` to a specifier, so the dotted-infix
 * regression now fails the guard.
 *
 * The guard also fails closed: a missing or empty scan root is an error rather
 * than a vacuous pass (SAA-813 security-low finding), since it runs as
 * `postbuild`/`postbuild:prod` immediately after a build must have produced the
 * roots.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const RUNTIME_ROOTS = ["lib/cjs", "lib/esm"];
const EMITTED_RUNTIME_FILE = /\.(?:cjs|mjs|js)$/;
const CJS_EXTENSIONS = [".js", ".json", ".node"];
const CJS_INDEX_FILES = ["index.js", "index.json", "index.node"];

// require("...") | from "..." (import/export) | import("...") | import "..."
const SPECIFIER_PATTERN =
  /require\(\s*["']([^"']+)["']\s*\)|(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w.$])import\s*["']([^"']+)["']/gm;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Determine the module system Node uses to load an emitted file, mirroring the
// Node loader: `.mjs` is always ESM, `.cjs` is always CJS, and `.js` follows
// the nearest `package.json` `"type"` field (defaulting to CJS).
function moduleMode(file) {
  const ext = path.extname(file);
  if (ext === ".mjs") return "esm";
  if (ext === ".cjs") return "cjs";
  let dir = path.dirname(file);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (isFile(pkgPath)) {
      try {
        return JSON.parse(fs.readFileSync(pkgPath, "utf8")).type === "module"
          ? "esm"
          : "cjs";
      } catch {
        return "cjs";
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "cjs";
    dir = parent;
  }
}

// Node's ESM relative resolution is exact-path only: no extension inference,
// no directory index, no `.cjs`/`.mjs` appending.
function resolvesEsm(importer, specifier) {
  return isFile(path.resolve(path.dirname(importer), specifier));
}

// Node's CJS relative resolution (LOAD_AS_FILE + LOAD_AS_DIRECTORY index).
function resolvesCjs(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  if (isFile(base)) return true;
  if (CJS_EXTENSIONS.some((ext) => isFile(`${base}${ext}`))) return true;
  if (isDirectory(base)) {
    if (CJS_INDEX_FILES.some((name) => isFile(path.join(base, name)))) {
      return true;
    }
  }
  return false;
}

function resolves(importer, specifier) {
  return moduleMode(importer) === "esm"
    ? resolvesEsm(importer, specifier)
    : resolvesCjs(importer, specifier);
}

function relativeSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (
      specifier &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      found.push(specifier);
    }
  }
  return found;
}

// Fail closed: a scan root that is absent (or present but holding no emitted
// runtime file) means the guard cannot prove anything, so it must not report OK.
const missingRoots = [];
const files = RUNTIME_ROOTS.flatMap((root) => {
  const absolute = path.join(ROOT, root);
  if (!isDirectory(absolute)) {
    missingRoots.push(root);
    return [];
  }
  return walk(absolute).filter((file) => EMITTED_RUNTIME_FILE.test(file));
});

if (missingRoots.length > 0) {
  console.error(
    `[check-emitted-relative-specifiers] scan root(s) missing: ${missingRoots.join(
      ", "
    )}.`
  );
  console.error(
    "The guard runs after the build, so the emitted roots must exist. " +
      "Rebuild, or remove the postbuild hook if emitted output is genuinely " +
      "optional."
  );
  process.exit(1);
}

if (files.length === 0) {
  console.error(
    `[check-emitted-relative-specifiers] no emitted runtime files found under ${RUNTIME_ROOTS.join(
      ", "
    )}; refusing to pass vacuously.`
  );
  process.exit(1);
}

let checked = 0;
const broken = [];
for (const file of files) {
  for (const specifier of relativeSpecifiers(fs.readFileSync(file, "utf8"))) {
    checked += 1;
    if (!resolves(file, specifier)) {
      broken.push({ file: path.relative(ROOT, file), specifier });
    }
  }
}

if (broken.length > 0) {
  console.error(
    `[check-emitted-relative-specifiers] ${broken.length} unresolved relative module specifier(s) in emitted output:`
  );
  for (const { file, specifier } of broken) {
    console.error(`  - ${file} -> ${specifier}`);
  }
  console.error(
    "The emitted registry is unloadable. Confirm the build resolved a " +
      "@decaf-ts/utils build-scripts that rewrites dotted-infix relative " +
      "specifiers (>=1.11.0), then rebuild."
  );
  process.exit(1);
}

console.log(
  `[check-emitted-relative-specifiers] OK — ${checked} relative module specifier(s) across ${files.length} emitted file(s) resolve.`
);
