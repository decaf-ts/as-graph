const config = {
  verbose: true,
  // eslint-disable-next-line no-undef
  rootDir: __dirname,
  transform: { "^.+\\.ts$": "ts-jest" },
  testEnvironment: "node",
  testRegex: "/tests/.*\\.(test|spec|e2e)\\.(ts|tsx)$",
  // UI suites (storybook story runner + e2e UI) need a DOM environment and are
  // run by jest.ui.config.cjs with the .storybook tsconfig instead.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/tests/e2e/ui/",
    "/tests/storybook/",
  ],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  collectCoverage: false,
  coverageDirectory: "./workdocs/reports/coverage",
  collectCoverageFrom: ["src/**/*.{js,jsx,ts,tsx}", "!src/bin"],
  reporters: ["default"],
  watchman: false,
};

// eslint-disable-next-line no-undef
module.exports = config;
