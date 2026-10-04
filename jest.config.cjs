const config = {
  verbose: true,
  // eslint-disable-next-line no-undef
  rootDir: __dirname,
  transform: {
    "^.+\\.ts$": "ts-jest",
    // `@decaf-ts/crypto` (pulled in transitively via
    // `@decaf-ts/integrations/nest`) requires the ESM-only `jose` package.
    // Compile jose's JS with ts-jest so it loads under the CommonJS jest
    // runtime (mirrors the crypto package's own jest config).
    "node_modules/jose/.+\\.js$": "ts-jest",
    // `@mastra/core` (the `./mastra` backend under test) is published as
    // CJS that `require`s ESM-only dependencies (`@ai-sdk/*`, `@workflow/*`).
    // Compile those JS sources with ts-jest so the Mastra driver tests load
    // under the CommonJS jest runtime.
    "node_modules/@mastra/.+\\.js$": "ts-jest",
    "node_modules/@ai-sdk/.+\\.js$": "ts-jest",
    "node_modules/@workflow/.+\\.js$": "ts-jest",
  },
  testEnvironment: "node",
  testRegex: "/tests/.*\\.(test|spec|e2e)\\.(ts|tsx)$",
  testPathIgnorePatterns: ["/node_modules/"],
  transformIgnorePatterns: [
    "node_modules/(?!(jose|@mastra|@ai-sdk|@workflow)/)",
  ],
  // as-graph is developed inside the decaf-ts umbrella repo, where `@decaf-ts/*`
  // dependencies exist both in this package's node_modules and in the transitive
  // packages' node_modules (e.g. `@decaf-ts/integrations`). Without pinning,
  // jest loads a second copy of the stateful `@decaf-ts/decoration` Metadata
  // registry, so `@namespace(...)` writes to one copy while as-graph reads the
  // other. Pin every bare `@decaf-ts/*` import to this package's own copy so the
  // whole test graph shares one instance of each package.
  moduleNameMapper: {
    "^@decaf-ts/([^/]+)$": "<rootDir>/node_modules/@decaf-ts/$1",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  collectCoverage: false,
  coverageDirectory: "./workdocs/reports/coverage",
  collectCoverageFrom: ["src/**/*.{js,jsx,ts,tsx}", "!src/bin"],
  reporters: ["default"],
  watchman: false,
};

// eslint-disable-next-line no-undef
module.exports = config;
