/**
 * Jest config for the mastra eval suite (SAA-836 E1): picks up ONLY the
 * `.eval.ts` files under `tests/evals`, keeping them fully independent of the
 * normal jest suite (`jest.config.cjs` matches `(test|spec|e2e)` only, so the
 * eval files never run with it). Run with `npm run test:evals`.
 */
const config = {
  verbose: true,
  // eslint-disable-next-line no-undef
  rootDir: __dirname,
  transform: {
    "^.+\\.ts$": "ts-jest",
    // `@decaf-ts/crypto` (pulled in transitively via `@decaf-ts/integrations`)
    // requires the ESM-only `jose` package, and `@mastra/core` is published as
    // CJS that `require`s ESM-only dependencies (`@ai-sdk/*`, `@workflow/*`).
    // Compile those JS sources with ts-jest so the eval suite loads under the
    // CommonJS jest runtime (mirrors the main jest config).
    "node_modules/jose/.+\\.js$": "ts-jest",
    "node_modules/@mastra/.+\\.js$": "ts-jest",
    "node_modules/@ai-sdk/.+\\.js$": "ts-jest",
    "node_modules/@workflow/.+\\.js$": "ts-jest",
    // The mastra `.cjs` chunks (DatasetsManager/agent/tools/workspace) call
    // dynamic `import()` (e.g. `await import("p-map")` in the datasets
    // manager). Node refuses dynamic import inside jest's VM
    // (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`), so the chunks are
    // compiled through ts-jest, which rewrites the dynamic `import()` to
    // `require` under the CommonJS module target. Eval config only: the main
    // jest suite never reaches these chunks.
    "node_modules/@mastra/.+\\.cjs$": "ts-jest",
  },
  testEnvironment: "node",
  testRegex: "/tests/evals/.*\\.eval\\.ts$",
  testPathIgnorePatterns: ["/node_modules/", "/n8n/"],
  transformIgnorePatterns: [
    "node_modules/(?!(jose|@mastra|@ai-sdk|@workflow)/)",
  ],
  // Pin every bare `@decaf-ts/*` import to this package's own copy so the whole
  // test graph shares one instance of each package (same rationale as the main
  // jest config: the stateful `@decaf-ts/decoration` Metadata registry must not
  // be duplicated).
  moduleNameMapper: {
    "^@decaf-ts/([^/]+)$": "<rootDir>/node_modules/@decaf-ts/$1",
    // The mastra datasets manager loads `p-map` through a dynamic `import()`
    // that Node refuses inside jest's VM; after the ts-jest CommonJS rewrite
    // it becomes `require("p-map")` against p-map's ESM-only package. Map it
    // to the minimal CommonJS shim in this directory (see `p-map.cjs`).
    "^p-map$": "<rootDir>/tests/evals/p-map.cjs",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  collectCoverage: false,
  reporters: ["default"],
  watchman: false,
};

// eslint-disable-next-line no-undef
module.exports = config;
