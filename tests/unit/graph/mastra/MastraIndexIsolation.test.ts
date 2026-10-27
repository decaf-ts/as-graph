/**
 * @module as-graph/tests/unit/graph/mastra/MastraIndexIsolation
 * @summary SAA-1547 §7: loading the main `src/index.ts` entry must not load the
 * `@mastra/core` runtime or the Mastra node implementations.
 * @description The engine-neutral convenience export is loaded in an isolated
 * module registry while every Mastra runtime entry throws on import. A green
 * test proves the general engine's public surface never reaches the Mastra
 * ownership tree at runtime.
 */
import { describe, it, expect, jest } from "@jest/globals";

jest.mock("@mastra/core", () => {
  throw new Error("@mastra/core must not load from the main src/index entry");
});
jest.mock("@mastra/core/workflows", () => {
  throw new Error(
    "@mastra/core/workflows must not load from the main src/index entry"
  );
});
jest.mock("@mastra/core/mastra", () => {
  throw new Error(
    "@mastra/core/mastra must not load from the main src/index entry"
  );
});

describe("main entry isolation (SAA-1547 §7)", () => {
  it("loads src/index without loading @mastra/core", async () => {
    await jest.isolateModulesAsync(async () => {
      const entry = await import("../../../../src/index");
      expect(entry.GraphExecutionEngine).toBeDefined();
      expect(entry.GraphNodeCatalogue).toBeDefined();
    });
  });
});
