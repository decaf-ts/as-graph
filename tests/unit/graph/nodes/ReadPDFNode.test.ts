/**
 * @module as-graph/tests/unit/graph/nodes/ReadPDFNode.test
 * @summary Unit coverage for the `core.io.readPDF` general-engine node.
 * @description Parses the vendored `tests/fixtures/read-pdf-sample.pdf` fixture
 * through the production `pdf-parse` dependency and asserts the extracted text,
 * page count, base64
 * input, object-wrapper input, and the invalid-input failure code.
 *
 * `pdf-parse` delegates to `pdfjs-dist`, whose Node fake-worker path performs a
 * dynamic `import()`. Jest's CommonJS VM therefore needs
 * `NODE_OPTIONS=--experimental-vm-modules`; run this file through
 * `jest.pdf.config.cjs` (see `npm run test:unit:pdf`) instead of the default
 * unit lane, and keep its imports to the PDF node module so the Mastra/ESM
 * dependency graph is not pulled into the VM-modules runtime.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ReadPDFNode } from "../../../../src/node/io/read-pdf/node";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

const KIND = "core.io.readPDF";
const FIXTURE = resolve(__dirname, "../../../fixtures/read-pdf-sample.pdf");

describe("core.io.readPDF", () => {
  it("extracts the text and page count from a real PDF buffer", async () => {
    const context = buildNodeContext(KIND, {});
    const result = await executeNode(
      ReadPDFNode,
      nodeExecutionRequest({ value: readFileSync(FIXTURE) }),
      context
    );

    expect(result.result).toContain("N8N");
    expect(result.result).toContain("Sample PDF");
    expect(result.result).toContain("Lorem ipsum dolor sit amet");
    const pages = result.pages as { pageNumber: number; text: string }[];
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].text).toContain("Sample PDF");
  });

  it("accepts a base64 payload and an object wrapper", async () => {
    const base64 = readFileSync(FIXTURE).toString("base64");
    const fromBase64 = await executeNode(
      ReadPDFNode,
      nodeExecutionRequest({ value: base64 }),
      buildNodeContext(KIND, { parameters: { encoding: "base64" } })
    );
    expect(fromBase64.result).toContain("Sample PDF");

    const fromWrapper = await executeNode(
      ReadPDFNode,
      nodeExecutionRequest({ value: { data: readFileSync(FIXTURE) } }),
      buildNodeContext(KIND, {})
    );
    expect(fromWrapper.result).toContain("Sample PDF");
  });

  it("rejects non-file payloads", async () => {
    await expect(
      executeNode(
        ReadPDFNode,
        nodeExecutionRequest({ value: 42 }),
        buildNodeContext(KIND, {})
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_PDF_INVALID_INPUT" });
  });
});
