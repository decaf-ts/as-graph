/**
 * @module as-graph/tests/integration/it-env.setup
 * @summary Jest setup file that loads the integration-test environment written
 * by `npm run prepare-it-tests`.
 * @description The live suites resolve their endpoints from environment
 * variables (SAA-1032 endpoints, `GRAPH_IT_*`, `MASTRA_IT_*`, Dagster URL).
 * `prepare-it-tests` writes those values to the git-ignored
 * `var/as-graph-it/.it-env.json` after it has verified every service; this file
 * applies them before any test module is loaded, without overriding a value the
 * caller already exported. When the file is absent (no infra booted) the live
 * suites fall back to their honest skip contract.
 */
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const ENV_FILE = join(__dirname, "..", "..", "var", "as-graph-it", ".it-env.json");

if (existsSync(ENV_FILE)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ENV_FILE, "utf8"));
  } catch (error) {
    throw new Error(
      `prepare-it-tests wrote an unreadable ${ENV_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    if (process.env[name] === undefined) process.env[name] = String(value);
  }
}
