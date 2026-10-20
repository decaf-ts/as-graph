/**
 * @module as-graph/tests/integration/graph/nodes/io/ReadPDFLive
 * @summary SAA-1144 live integration coverage for `core.io.readPDF`.
 * @description Parses the real PDF fixture through the production
 * `pdf-parse`/`pdfjs-dist` path. Because `pdfjs-dist` sets up its fake worker
 * with a dynamic `import()`, this file runs in the VM-modules lane
 * (`jest.pdf.config.cjs`), exactly like the unit suite, and is excluded from
 * the default lane. It imports only the PDF node module so the Mastra/ESM graph
 * is not pulled into the VM-modules runtime.
 */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReadPDFNode } from "../../../../../src/node/io/read-pdf/node";
import { executeNode, nodeExecutionRequest } from "../../../../unit/graph/engine-fixtures";
import { buildNodeContext } from "../../../../unit/graph/nodes/node-test-utils";

const KIND = "core.io.readPDF";
const FIXTURE = resolve(__dirname, "../../../../fixtures/read-pdf-sample.pdf");

describe("core.io.readPDF — live pdfjs-dist parse", () => {
  it("extracts text and page geometry from a real PDF file", async () => {
    const result = await executeNode(
      ReadPDFNode,
      nodeExecutionRequest({ value: readFileSync(FIXTURE) }),
      buildNodeContext(KIND, {})
    );

    expect(result.result).toContain("N8N");
    expect(result.result).toContain("Sample PDF");
    const pages = result.pages as Array<{ pageNumber: number; text: string }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].text).toContain("Lorem ipsum dolor sit amet");
  });

  it("accepts a base64 payload from a real file read", async () => {
    const base64 = readFileSync(FIXTURE).toString("base64");
    const result = await executeNode(
      ReadPDFNode,
      nodeExecutionRequest({ value: base64 }),
      buildNodeContext(KIND, { parameters: { encoding: "base64" } })
    );
    expect(result.result).toContain("Sample PDF");
  });
});
