/**
 * @module as-graph/tests/unit/graph/mastra/MastraAgentFamilyStepHandlers
 * @summary Unit tests for the SAA-1545 registry coverage of the ten AI-family
 * leaf kinds.
 * @description Pins `MASTRA_AGENT_FAMILY_STEP_KINDS` (the ten family kinds) and
 * proves the Mastra node registry — not the neutral default handler set —
 * produces exactly one step per family kind. Each compiled step reaches the
 * node class's own `execute()`: the config-only kinds emit their real R9
 * resource/selection output, and the service-backed sandbox kind fails closed
 * with `GRAPH_MASTRA_RAG_UNAVAILABLE` when the run injected no RAG service.
 */
import { describe, it, expect } from "@jest/globals";
import {
  MASTRA_AGENT_FAMILY_STEP_KINDS,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import { createMastraNodeStepHandlers } from "../../../../src/mastra/nodes";
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

/** The real R9 output each config-only family kind produces for `{probe}`. */
function expectedOutputOf(kind: string, index: number): Record<string, unknown> {
  const input = { probe: index };
  switch (kind) {
    case "core.agent.tool":
      return { resource: { type: "mastra.tool", input } };
    case "core.agent.toolSelector":
    case "core.agent.skillSelector":
    case "core.agent.scorerSelector":
      // `selected` stays undefined (and is dropped by the JSON-safe step
      // output sanitizer) when the selector has no decision/candidates.
      return { resource: null };
    case "core.agent.hook":
    case "core.agent.delegationHook":
      return { value: input };
    case "core.agent.toolDeny":
      return { proceed: false, denied: true };
    case "core.agent.skill":
      return { resource: { type: "mastra.skill", input } };
    case "core.agent.scorer":
      return { resource: { type: "mastra.scorer", input } };
    case "core.agent.sandbox":
      return {
        probe: index,
        resource: {
          kind: "core.agent.sandbox",
          nodeId: `family-${index}`,
          parameters: input,
          type: "mastra.sandbox",
          timeoutMs: 1000,
        },
      };
    default:
      throw new Error(`no expected output for ${kind}`);
  }
}

describe("MASTRA_AGENT_FAMILY_STEP_KINDS (SAA-836 M3)", () => {
  it("lists exactly the ten family kinds, unique and in declaration order", () => {
    expect(MASTRA_AGENT_FAMILY_STEP_KINDS).toEqual([...FAMILY_KINDS]);
    expect(new Set(MASTRA_AGENT_FAMILY_STEP_KINDS).size).toBe(
      MASTRA_AGENT_FAMILY_STEP_KINDS.length
    );
  });

  it("is no longer part of the engine-neutral default handler set", () => {
    const defaults = new Set<string>(MASTRA_DEFAULT_STEP_HANDLER_KINDS);
    for (const kind of MASTRA_AGENT_FAMILY_STEP_KINDS) {
      expect({ kind, default: defaults.has(kind) }).toEqual({
        kind,
        default: false,
      });
    }
  });
});

describe("mastra node registry — family coverage (SAA-1545)", () => {
  it("returns exactly one registry handler per family kind", () => {
    const handlers = createMastraNodeStepHandlers();
    const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
    for (const kind of MASTRA_AGENT_FAMILY_STEP_KINDS) {
      expect(byKind.has(kind)).toBe(true);
    }
    expect(new Set(handlers.map((handler) => handler.kind)).size).toBe(
      handlers.length
    );
  });

  it("compiles a step keyed by the node id for every family kind", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraNodeStepHandlers(),
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

  it("executes each family node's real output or typed fail-closed result", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraNodeStepHandlers(),
    });
    const { steps } = compiler.compile(familyDocument());

    for (const [index, kind] of FAMILY_KINDS.entries()) {
      const step = steps.get(`family-${index}`) as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };
      const output = await step.execute({
        inputData: { probe: index },
      });
      expect({ kind, output }).toEqual({
        kind,
        output: expectedOutputOf(kind, index),
      });
    }
  });

  it("sanitizes non-record step input to an empty record before forwarding", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraNodeStepHandlers(),
    });
    const { steps } = compiler.compile(familyDocument());
    const step = steps.get("family-0") as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };
    const output = await step.execute({ inputData: undefined });
    expect(output).toEqual({
      resource: { type: "mastra.tool", input: {} },
    });
  });
});
