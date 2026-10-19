/**
 * @module as-graph/tests/unit/graph/mastra/MastraProcessorVariants
 * @summary SAA-1066 unit evidence: the Stage 4 processor variants and guards.
 * @description Pins that every new JSON-config-safe input/output processor
 * variant constructs a real `@mastra/core/processors` instance when configured
 * correctly, and that each guard rejects its non-serializable or unsupported
 * option with `GRAPH_MASTRA_PROCESSOR_UNAVAILABLE`:
 * `tokenCostControl` requires a positive numeric `maxCost`;
 * `modelSelection` requires a valid model adapter per choice;
 * `providerHistoryCompat` rejects `additionalRules`; `streamErrorRetry` rejects
 * `matchers`; and the no-options variants reject any options object.
 *
 * `modelSelection` resolves the per-choice adapters from the node config, but
 * its classifier decision model must come from the host `resolveProcessorModel`
 * resolver: without it the node fails closed with
 * `GRAPH_MASTRA_PROCESSOR_UNAVAILABLE` rather than composing a language-model
 * id mastra's classifier cannot use.
 */
import { describe, expect, it } from "@jest/globals";
import {
  BatchPartsProcessor,
  CyberRefusalHandler,
  ModelSelectionProcessor,
  PrefillErrorHandler,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
  TokenCostControl,
  UnsupportedFileHandler,
} from "@mastra/core/processors";
import {
  mastraProcessorInstanceOf,
  type MastraProcessorModelResolver,
} from "../../../../src/mastra/MastraAgentProcessors";
import {
  MASTRA_INPUT_PROCESSOR_TYPES,
  MASTRA_OUTPUT_PROCESSOR_TYPES,
} from "../../../../src/node/agents/processors/types";
import { GRAPH_MASTRA_PROCESSOR_UNAVAILABLE } from "../../../../src/mastra/types";
import { node } from "../../../../src/workflows/builders";

/** A valid model-adapter config for a model-carrying variant. */
const adapter = {
  provider: "openai",
  modelId: "gpt-4o-mini",
};

/**
 * A host model resolver returning a stable decision-model sentinel. Mastra's
 * classifier validates the decision model structurally, so the sentinel carries
 * the `supportedQuestionTypes` capability the classifier reads at construction.
 */
const resolvedModel = {
  provider: "openai",
  modelId: "gpt-4o-mini",
  supportedQuestionTypes: ["choice", "score", "boolean"],
};
const resolver: MastraProcessorModelResolver = () => resolvedModel;

/** Returns the graph code of a rejected async call, or `undefined`. */
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

/** Builds an input-processor node. */
function input(processorType: string, options: Record<string, unknown> = {}) {
  return node("p", "core.agent.inputProcessor", {
    processorType,
    options,
  });
}

/** Builds an output-processor node. */
function output(processorType: string, options: Record<string, unknown> = {}) {
  return node("p", "core.agent.outputProcessor", {
    processorType,
    options,
  });
}

describe("mastra processor variant vocabulary (SAA-1066)", () => {
  it("exposes the Stage 4 input and output variants", () => {
    expect([...MASTRA_INPUT_PROCESSOR_TYPES]).toEqual(
      expect.arrayContaining(["tokenCostControl", "modelSelection"])
    );
    expect([...MASTRA_OUTPUT_PROCESSOR_TYPES]).toEqual(
      expect.arrayContaining([
        "batchParts",
        "providerHistoryCompat",
        "cyberRefusalHandler",
        "prefillErrorHandler",
        "streamErrorRetry",
        "unsupportedFileHandler",
      ])
    );
  });
});

describe("mastra input processor variants (SAA-1066)", () => {
  it("constructs tokenCostControl only with a positive finite maxCost", async () => {
    const instance = await mastraProcessorInstanceOf(
      input("tokenCostControl", { maxCost: 0.5 })
    );
    expect(instance).toBeInstanceOf(TokenCostControl);

    for (const maxCost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined]) {
      expect(
        await rejectionGraphCodeOf(() =>
          mastraProcessorInstanceOf(input("tokenCostControl", { maxCost }))
        )
      ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
    }
  });

  it("rejects modelSelection choices that are missing or lack a model adapter", async () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { choices: [] },
      { choices: "not-an-array" },
      { choices: [null] },
      { choices: [{ modelAdapter: adapter }] },
      { choices: [{ criteria: "simple" }] },
      { choices: [{ criteria: "   ", modelAdapter: adapter }] },
      {
        choices: [
          { criteria: "simple", modelAdapter: { provider: "openai" } },
        ],
      },
      {
        choices: [{ criteria: "simple", modelAdapter: { modelId: "m" } }],
      },
    ];
    for (const options of cases) {
      expect(
        await rejectionGraphCodeOf(() =>
          mastraProcessorInstanceOf(input("modelSelection", options))
        )
      ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
    }
  });

  it("constructs modelSelection when every choice declares an adapter", async () => {
    const instance = await mastraProcessorInstanceOf(
      input("modelSelection", {
        choices: [
          { criteria: "simple", modelAdapter: adapter, name: "fast" },
          {
            criteria: "hard",
            modelAdapter: { provider: "openai", modelId: "gpt-4o" },
            name: "smart",
          },
        ],
      }),
      resolver
    );
    expect(instance).toBeInstanceOf(ModelSelectionProcessor);
  });

  it("requires a host resolver for the modelSelection classifier model", async () => {
    const modelSelectionNode = node("p", "core.agent.inputProcessor", {
      processorType: "modelSelection",
      modelAdapter: adapter,
      options: {
        choices: [
          { criteria: "simple", modelAdapter: adapter, name: "fast" },
          {
            criteria: "hard",
            modelAdapter: { provider: "openai", modelId: "gpt-4o" },
            name: "smart",
          },
        ],
      },
    });

    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(modelSelectionNode)
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);

    const instance = await mastraProcessorInstanceOf(
      modelSelectionNode,
      resolver
    );
    expect(instance).toBeInstanceOf(ModelSelectionProcessor);
  });

  it("requires at least two modelSelection choices", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        mastraProcessorInstanceOf(
          input("modelSelection", {
            choices: [{ criteria: "only", modelAdapter: adapter }],
          }),
          resolver
        )
      )
    ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
  });
});

describe("mastra output processor variants (SAA-1066)", () => {
  it("constructs every new JSON-config-safe output variant", async () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ["batchParts", { batchSize: 2, maxWaitTime: 10 }, BatchPartsProcessor],
      ["providerHistoryCompat", {}, ProviderHistoryCompat],
      ["cyberRefusalHandler", {}, CyberRefusalHandler],
      ["prefillErrorHandler", {}, PrefillErrorHandler],
      ["streamErrorRetry", { maxRetries: 2, delayMs: 10 }, StreamErrorRetryProcessor],
      ["unsupportedFileHandler", {}, UnsupportedFileHandler],
    ];
    for (const [processorType, options, expected] of cases) {
      const instance = await mastraProcessorInstanceOf(
        output(processorType, options)
      );
      expect(instance).toBeInstanceOf(expected);
    }
  });

  it("rejects providerHistoryCompat additionalRules and any other options", async () => {
    for (const options of [
      { additionalRules: [] },
      { additionalRules: [{ name: "r", errorPatterns: [] }] },
      { enabled: true },
    ]) {
      expect(
        await rejectionGraphCodeOf(() =>
          mastraProcessorInstanceOf(output("providerHistoryCompat", options))
        )
      ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
    }
  });

  it("rejects streamErrorRetry matchers and keeps the numeric knobs", async () => {
    for (const options of [
      { matchers: [] },
      { matchers: [{ match: "x" }] },
      { maxRetries: 2, matchers: [] },
    ]) {
      expect(
        await rejectionGraphCodeOf(() =>
          mastraProcessorInstanceOf(output("streamErrorRetry", options))
        )
      ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
    }

    const instance = await mastraProcessorInstanceOf(
      output("streamErrorRetry", {
        maxRetries: 1,
        delayMs: 5,
        retryUnknownErrors: false,
      })
    );
    expect(instance).toBeInstanceOf(StreamErrorRetryProcessor);
  });

  it("rejects options on the no-options output variants", async () => {
    for (const processorType of [
      "cyberRefusalHandler",
      "prefillErrorHandler",
      "unsupportedFileHandler",
    ]) {
      for (const options of [{ enabled: true }, { anything: 1 }]) {
        expect(
          await rejectionGraphCodeOf(() =>
            mastraProcessorInstanceOf(output(processorType, options))
          )
        ).toBe(GRAPH_MASTRA_PROCESSOR_UNAVAILABLE);
      }
    }
  });
});
