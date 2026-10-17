/**
 * @module as-graph/tests/unit/graph/mastra/MastraAgentFamilyStepHandlers
 * @summary Unit tests for the SAA-836 M3 mastra default step-handler coverage of
 * the ten AI-family leaf kinds.
 * @description Pins `MASTRA_AGENT_FAMILY_STEP_KINDS` (the ten family kinds), that
 * every family kind is covered by `MASTRA_DEFAULT_STEP_HANDLER_KINDS` with exactly
 * one handler, and that each compiled family step resolves the node's
 * configuration into a `resource` descriptor on its output while forwarding the
 * input — the R9 real-mastra-step contract.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createMastraDefaultStepHandlers,
  MASTRA_AGENT_FAMILY_STEP_KINDS,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { document, node } from "../../../../src/workflows/builders";

/** The ten SAA-836 M3 family kinds, in declaration order. */
const FAMILY_KINDS = [
  "core.agent.tool",
  "core.agent.toolSelector",
  "core.agent.hook",
  "core.agent.toolDeny",
  "core.agent.delegationHook",
  "core.agent.skill",
  "core.agent.skillSelector",
  "core.agent.sandbox",
  "core.agent.scorer",
  "core.agent.scorerSelector",
] as const;

/** A canonical document with one node per family kind. */
function familyDocument() {
  return document({
    id: "mastra-agent-family-handlers",
    name: "mastra-agent-family-handlers",
    nodes: FAMILY_KINDS.map((kind, index) =>
      node(`family-${index}`, kind, { probe: index })
    ),
  });
}

/** The deterministic node id for a family kind (its index in the document). */
function nodeIdOf(kind: string): string {
  return `family-${FAMILY_KINDS.indexOf(kind as (typeof FAMILY_KINDS)[number])}`;
}

describe("MASTRA_AGENT_FAMILY_STEP_KINDS (SAA-836 M3)", () => {
  it("lists exactly the ten family kinds, unique and in declaration order", () => {
    expect(MASTRA_AGENT_FAMILY_STEP_KINDS).toEqual([...FAMILY_KINDS]);
    expect(new Set(MASTRA_AGENT_FAMILY_STEP_KINDS).size).toBe(
      MASTRA_AGENT_FAMILY_STEP_KINDS.length
    );
  });

  it("is a subset of the default handler kinds", () => {
    const defaults = new Set<string>(MASTRA_DEFAULT_STEP_HANDLER_KINDS);
    for (const kind of MASTRA_AGENT_FAMILY_STEP_KINDS) {
      expect(defaults.has(kind)).toBe(true);
    }
  });
});

describe("mastra default step handlers — family coverage (SAA-836 M3)", () => {
  it("returns exactly one handler per family kind", () => {
    const handlers = createMastraDefaultStepHandlers();
    const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
    for (const kind of MASTRA_AGENT_FAMILY_STEP_KINDS) {
      expect(byKind.has(kind)).toBe(true);
    }
    expect(handlers).toHaveLength(MASTRA_DEFAULT_STEP_HANDLER_KINDS.length);
  });

  it("compiles a step keyed by the node id for every family kind", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const { steps } = compiler.compile(familyDocument());
    for (const kind of FAMILY_KINDS) {
      const nodeId = nodeIdOf(kind);
      const step = steps.get(nodeId);
      expect({ kind, nodeId, defined: step !== undefined }).toEqual({
        kind,
        nodeId,
        defined: true,
      });
      expect(step?.id).toBe(nodeId);
    }
  });

  it("executes each family step forwarding input and resolving the resource", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const { steps } = compiler.compile(familyDocument());
    const input = { alpha: 1, nested: { beta: 2 } };

    for (const [index, kind] of FAMILY_KINDS.entries()) {
      const nodeId = `family-${index}`;
      const step = steps.get(nodeId) as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };
      const output = await step.execute({ inputData: input });
      expect(output).toEqual({
        ...input,
        resource: {
          kind,
          nodeId,
          parameters: { probe: index },
        },
      });
    }
  });

  it("sanitizes non-record step input to an empty record before forwarding", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const { steps } = compiler.compile(familyDocument());
    const step = steps.get("family-0") as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };
    const output = await step.execute({ inputData: undefined });
    expect(output).toEqual({
      resource: {
        kind: "core.agent.tool",
        nodeId: "family-0",
        parameters: { probe: 0 },
      },
    });
  });
});
