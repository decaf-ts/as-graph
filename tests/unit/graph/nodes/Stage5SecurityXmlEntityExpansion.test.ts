/**
 * @module as-graph/tests/unit/graph/nodes/Stage5SecurityXmlEntityExpansion.test
 * @summary SAA-1471 exploit-demonstration coverage for XML entity expansion
 * (SAA-1468 finding M2).
 * @description Feeds bounded billion-laughs documents, deeply nested elements,
 * and oversized text nodes through the real `core.io.xml` (`xmlToJson`) node.
 * The bounded cases must fail as typed `GRAPH_XML_*` errors (or complete
 * without unbounded expansion), and the entity-bearing document is rejected by
 * the explicit entity guard. Every case runs in the default suite.
 */
import { describe, it, expect } from "@jest/globals";

import { XmlNode } from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionValues } from "../../../../src/engine/types";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";


interface XmlOutcome {
  value?: GraphExecutionValues;
  error?: unknown;
}

async function attemptXml(xml: string): Promise<XmlOutcome> {
  try {
    const context = buildNodeContext("core.io.xml", {
      parameters: { mode: "xmlToJson" },
    });
    return {
      value: await executeNode(
        XmlNode as GraphNodeClass,
        nodeExecutionRequest({ value: xml }),
        context
      ),
    };
  } catch (error) {
    return { error };
  }
}

/**
 * Builds a billion-laughs chain that would expand to roughly
 * `leaf.length * fanout ** depth` bytes. The default is about 2.5 MB, which
 * demonstrates the amplification without putting the CI worker at risk.
 */
function laughsChain(
  depth = 6,
  fanout = 8,
  leaf = "0123456789"
): string {
  const entities = [`<!ENTITY a0 "${leaf}">`];
  for (let index = 1; index <= depth; index++) {
    const refs = Array.from(
      { length: fanout },
      () => `&a${index - 1};`
    ).join("");
    entities.push(`<!ENTITY a${index} "${refs}">`);
  }
  return `<?xml version="1.0"?><!DOCTYPE root [${entities.join(
    ""
  )}]><root>&a${depth};</root>`;
}

function assertTypedXmlError(error: unknown): GraphExecutionError {
  expect(error).toBeInstanceOf(GraphExecutionError);
  const graphError = error as GraphExecutionError;
  expect(graphError.graphCode).toMatch(/^GRAPH_XML_/);
  return graphError;
}

describe("SAA-1471 M2 — core.io.xml entity expansion", () => {
  it("rejects a bounded billion-laughs chain without expanding it or killing the process", async () => {
    const xml = laughsChain();
    expect(Buffer.byteLength(xml)).toBeLessThan(4096);

    const started = Date.now();
    const outcome = await attemptXml(xml);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    expect(outcome.error).toBeDefined();
    assertTypedXmlError(outcome.error);
    expect(outcome.value).toBeUndefined();
  });

  it("rejects entity declarations with an explicit GRAPH_XML entity guard", async () => {
    const outcome = await attemptXml(laughsChain());
    const graphError = assertTypedXmlError(outcome.error);
    expect([
      "GRAPH_XML_ENTITY_FORBIDDEN",
      "GRAPH_XML_INPUT_TOO_LARGE",
    ]).toContain(graphError.graphCode);
  });

  it(
    "rejects an oversized XML input with GRAPH_XML_INPUT_TOO_LARGE (SAA-1471; enable when SAA-750 defines the size cap)",
    async () => {
      const outcome = await attemptXml(
        `<root>${"x".repeat(12 * 1024 * 1024)}</root>`
      );
      const graphError = assertTypedXmlError(outcome.error);
      expect(graphError.graphCode).toBe("GRAPH_XML_INPUT_TOO_LARGE");
    }
  );

  it("fuzz: mixed entity, nesting, and oversized-text inputs fail only as typed GRAPH_XML_* errors", async () => {
    const cases: Array<{ name: string; xml: string }> = [
      { name: "nested entities", xml: laughsChain(4, 6, "x") },
      {
        name: "deep element nesting",
        xml: `${"<a>".repeat(1000)}x${"</a>".repeat(1000)}`,
      },
      {
        name: "oversized text node",
        xml: `<root>${"x".repeat(1024 * 1024)}</root>`,
      },
    ];

    const deadline = Date.now() + 10000;
    for (const entry of cases) {
      expect(Date.now()).toBeLessThan(deadline);
      const outcome = await attemptXml(entry.xml);
      if (outcome.error !== undefined) {
        const graphError = assertTypedXmlError(outcome.error);
        expect(graphError.graphCode.startsWith("GRAPH_XML_")).toBe(true);
      } else {
        expect(outcome.value).toBeDefined();
      }
    }

    // Reaching this assertion proves the process survived every parser input.
    expect(Date.now()).toBeLessThan(deadline);
  });
});
