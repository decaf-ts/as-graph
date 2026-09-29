/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const base = require("./jest.config.cjs");

// UI tests need a DOM environment and the DOM lib; the base config stays
// node-only so the backend suites keep their original compiler settings.
const uiBase = { ...base };
delete uiBase.testRegex;

module.exports = {
  ...uiBase,
  testEnvironment: "jsdom",
  testMatch: [
    "<rootDir>/tests/storybook/**/*.test.ts",
    "<rootDir>/tests/e2e/ui/**/*.test.ts",
  ],
  testPathIgnorePatterns: ["/node_modules/"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { tsconfig: "<rootDir>/.storybook/tsconfig.json" },
    ],
  },
};
