/**
 * Jest resolver that makes `TEST_TARGET=lib` exercise the emitted CommonJS
 * build instead of the TypeScript sources.
 *
 * The suites import the package through relative specifiers such as
 * `../../../src/shared/graph`. When `TEST_TARGET=lib` is set, this resolver
 * rewrites any relative specifier that lands inside `<rootDir>/src` to the
 * matching file inside `<rootDir>/lib/cjs`, so the whole suite runs against
 * the built artifact. `dist` is covered by `tests/unit/ts-workspace.test.ts`,
 * which loads the bundled `dist/as-graph.cjs`/`dist/as-graph.js` directly: the
 * bundle intentionally exposes only the package barrel, so the deep-import
 * suites cannot be retargeted to it.
 *
 * Unset (or `src`) keeps the historical source-mode resolution unchanged.
 *
 * @module as-graph/scripts/jest-target-resolver
 */
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(ROOT, "src");
const LIB_CJS_ROOT = path.join(ROOT, "lib", "cjs");
const CJS_CANDIDATES = [".cjs", ".js", ".json", ".node"];

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveEmitted(base) {
  if (isFile(base)) return base;
  for (const extension of CJS_CANDIDATES) {
    if (isFile(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const extension of CJS_CANDIDATES) {
    const index = path.join(base, `index${extension}`);
    if (isFile(index)) return index;
  }
  return null;
}

function mapSourceRequest(request, options) {
  if (!request.startsWith("./") && !request.startsWith("../")) return null;
  const sourcePath = path.resolve(options.basedir, request);
  const relative = path.relative(SRC_ROOT, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const emitted = resolveEmitted(path.join(LIB_CJS_ROOT, relative));
  if (!emitted) {
    throw new Error(
      `TEST_TARGET=lib could not find the emitted build for "${request}" ` +
        `(looked under ${LIB_CJS_ROOT}). Run "npm run build" before the lib pass.`
    );
  }
  return emitted;
}

module.exports = function targetResolver(request, options) {
  if (process.env.TEST_TARGET === "lib") {
    const emitted = mapSourceRequest(request, options);
    if (emitted) return emitted;
  }
  return options.defaultResolver(request, options);
};
