/**
 * @module as-graph/tests/unit/graph/mastra/MastraAgentProcessors
 * @summary Unit tests for the mastra processor/guardrail resolution layer
 * (SAA-836 M5).
 * @description Pins the zone wiring (`resolveAgentWiredProcessors`: input
 * processors onto the agent's `inputProcessors` pipeline, output processors and
 * guardrails onto `outputProcessors`, in document-edge order) and the real
 * `@mastra/core/processors` instances every known type resolves to, plus the
 * fail-closed matrix: unknown processor/guardrail types and model-carrying
 * types without a resolvable classifier model all fail closed with
 * `GRAPH_MASTRA_PROCESSOR_UNAVAILABLE`, and every known type with a model
 * resolver or a `modelAdapter` config resolves to a live processor instance.
 */
import { describe, it, expect } from "@jest/globals";
import {
  LanguageDetector,
  RegexFilterProcessor,
  TokenLimiterProcessor,
  ToolCallFilter,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import {
  mastraProcessorInstanceOf,
  MASTRA_AGENT_PROCESSOR_KINDS,
  resolveAgentWiredProcessors,
  type MastraModelAdapterConfig,
} from "../../../../src/mastra/MastraAgentProcessors";
import { GRAPH_MASTRA_PROCESSOR_UNAVAILABLE } from "../../../../src/mastra/types";
import { document, edge, node } from "../../../../src/workflows/builders";

/** Resolves the graph code of a rejected async call, or `undefined` when it resolved. */
async function rejectionGraphCodeOf(
  fn: () => Promise<unknown>
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}

describe("MastraAgentProcessors — zone wiring (SAA-836 M5)", () => {
  it("declares the three processor kinds", () => {
    expect([...MASTRA_AGENT_PROCESSOR_KINDS]).toEqual([
      "core.agent.inputProcessor",
      "core.agent.outputProcessor",
      "core.agent.guardrail",
    ]);
  });

  it("resolves an unconnected agent to empty pipelines", async () => {
    const wired = await resolveAgentWiredProcessors(
      document({
        id: "mastra-agent-no-processors",
        nodes: [node("agent", "core.agent")],
      }),
      "agent"
    );
    expect(wired).toEqual({ inputProcessors: [], outputProcessors: [] });
  });

  it("routes an input-processor node onto inputProcessors and an output-processor node onto outputProcessors", async () => {
    const source = document({
      id: "mastra-agent-pair",
      name: "mastra-agent-pair",
      nodes: [
        node("agent", "core.agent"),
        node("normalize", "core.agent.inputProcessor", {
          processorType: "unicodeNormalizer",
        }),
        node("limit", "core.agent.outputProcessor", {
          processorType: "tokenLimiter",
        }),
      ],
      edges: [
        edge(
          "e1",
          ["node", "normalize", "processor"],
          ["node", "agent", "inputProcessors"],
          "connection"
        ),
        edge(
          "e2",
          ["node", "limit", "processor"],
          ["node", "agent", "outputProcessors"],
          "connection"
        ),
      ],
    });

    const wired = await resolveAgentWiredProcessors(source, "agent");
    expect(wired.inputProcessors).toHaveLength(1);
    expect(wired.inputProcessors[0]).toBeInstanceOf(UnicodeNormalizer);
    expect(wired.outputProcessors).toHaveLength(1);
    expect(wired.outputProcessors[0]).toBeInstanceOf(TokenLimiterProcessor);
  });

  it("composes a guardrail with the output-processor pipeline in document-edge order", async () => {
    const source = document({
      id: "mastra-agent-guardrail-compose",
      name: "mastra-agent-guardrail-compose",
      nodes: [
        node("agent", "core.agent"),
        node("limit", "core.agent.outputProcessor", {
          processorType: "tokenLimiter",
        }),
        node("blocker", "core.agent.guardrail", {
          guardrailType: "regexFilter",
          strategy: "block",
          options: { rules: [{ pattern: new RegExp("SECRET"), name: "leak" }] },
        }),
        node("scrub", "core.agent.inputProcessor", {
          processorType: "unicodeNormalizer",
        }),
      ],
      edges: [
        edge(
          "e1",
          ["node", "blocker", "guardrail"],
          ["node", "agent", "outputProcessors"],
          "connection"
        ),
        edge(
          "e2",
          ["node", "limit", "processor"],
          ["node", "agent", "outputProcessors"],
          "connection"
        ),
        edge(
          "e3",
          ["node", "scrub", "processor"],
          ["node", "agent", "inputProcessors"],
          "connection"
        ),
      ],
    });

    const wired = await resolveAgentWiredProcessors(source, "agent");
    // Document-edge order: the guardrail edge precedes the token-limiter edge.
    expect(wired.outputProcessors).toHaveLength(2);
    expect(wired.outputProcessors[0]).toBeInstanceOf(RegexFilterProcessor);
    expect(wired.outputProcessors[1]).toBeInstanceOf(TokenLimiterProcessor);
    expect(wired.inputProcessors).toEqual([new UnicodeNormalizer()]);
  });

  it("forwards the node's options verbatim to the processor constructor", async () => {
    const filter = (await mastraProcessorInstanceOf(
      node("blocker", "core.agent.guardrail", {
        guardrailType: "regexFilter",
        strategy: "block",
        options: { rules: [{ pattern: new RegExp("SECRET"), name: "leak" }] },
      })
    )) as RegexFilterProcessor;
    expect(filter.strategy).toBe("block");
    expect(filter.findMatches("the key is SECRET here")).toEqual([
      { rule: "leak", match: "SECRET", index: 11 },
    ]);
  });
});

describe("MastraAgentProcessors — fail-closed matrix (SAA-836 M5)", () => {
  it("fails closed on an unknown input-processor type", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          node("bad", "core.agent.inputProcessor", {
            processorType: "doesNotExist",
          })
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("fails closed on an unknown output-processor type", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          node("bad", "core.agent.outputProcessor", {
            processorType: "doesNotExist",
          })
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("fails closed on an unknown guardrail type", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          node("bad", "core.agent.guardrail", {
            guardrailType: "doesNotExist",
          })
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("fails closed on a non-processor kind", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(node("bad", "core.agent.tool", {}))
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("fails closed on a model-carrying type with no model adapter and no host resolver", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          node("bad", "core.agent.inputProcessor", {
            processorType: "languageDetector",
          })
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("fails closed when the host model resolver yields nothing and no adapter is declared", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          node("bad", "core.agent.guardrail", {
            guardrailType: "moderation",
          }),
          async () => undefined
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });

  it("passes the wired node's model adapter to the host resolver", async () => {
    const adapter: MastraModelAdapterConfig = {
      provider: "pdm_ai",
      modelId: "DeepSeek-V4.1-Flash",
    };
    const received: Array<MastraModelAdapterConfig | undefined> = [];
    const processor = (await mastraProcessorInstanceOf(
      node("classifier", "core.agent.inputProcessor", {
        processorType: "languageDetector",
        modelAdapter: adapter,
      }),
      (receivedAdapter) => {
        received.push(receivedAdapter);
        return "pdm_ai/DeepSeek-V4.1-Flash";
      }
    )) as LanguageDetector;
    expect(received).toEqual([adapter]);
    // The classifier was accepted: the processor built its internal agent.
    expect((processor as { detectionAgent?: unknown }).detectionAgent).toBeDefined();
  });

  it("resolves a model-carrying type from the model adapter config alone", async () => {
    const processor = await mastraProcessorInstanceOf(
      node("classifier", "core.agent.inputProcessor", {
        processorType: "piiDetector",
        modelAdapter: { provider: "pdm_ai", modelId: "DeepSeek-V4.1-Flash" },
      })
    );
    expect(processor).toBeDefined();
  });

  it("does not fail closed for every known model-free type", async () => {
    for (const [kind, parameters, expected] of [
      ["core.agent.inputProcessor", { processorType: "unicodeNormalizer" }, UnicodeNormalizer],
      ["core.agent.outputProcessor", { processorType: "tokenLimiter" }, TokenLimiterProcessor],
      ["core.agent.outputProcessor", { processorType: "toolCallFilter" }, ToolCallFilter],
    ] as const) {
      const instance = await mastraProcessorInstanceOf(
        node("p", kind, parameters as Record<string, unknown>)
      );
      expect(instance).toBeInstanceOf(expected);
    }
  });
});
