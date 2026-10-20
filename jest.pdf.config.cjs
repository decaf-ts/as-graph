/**
 * Jest configuration for suites that require the Node VM-modules runtime.
 *
 * `pdf-parse` -> `pdfjs-dist` sets up its Node fake worker with a dynamic
 * `import()`, which Jest's CommonJS runtime only supports when Node is started
 * with `--experimental-vm-modules` (see `npm run test:unit:pdf`). Such suites
 * must avoid the Mastra-bearing `src/node` barrel so the VM-modules runtime does
 * not have to load ESM-flavoured Mastra transitive dependencies.
 *
 * @module as-graph/jest.pdf.config
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports,no-undef
const base = require("./jest.config.cjs");

const config = {
  ...base,
  testPathIgnorePatterns: ["/node_modules/", "/n8n/"],
  testRegex:
    "/tests/(unit|integration)/graph/nodes/(.*/)?ReadPDF(Node|Live)\\.test\\.ts$",
};

// eslint-disable-next-line no-undef
module.exports = config;
