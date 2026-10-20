/**
 * @module as-graph/tests/integration/mastra/MastraChannelsLive
 * @summary SAA-1144 coverage for the six mastra channel kinds.
 * @description Discord, Telegram, and Teams have no provisioned live
 * credential or self-hosted equivalent in this matrix, and mastra ships its
 * channel adapters as host-supplied packages (they are metadata-only in core).
 * Per the SAA-1144 brief these kinds are therefore **honest credential-gated
 * skips** in the live matrix, not fake-green vendor stubs. What this suite does
 * execute is the real production fail-closed contract: each compiled step must
 * reject with `GRAPH_MASTRA_CHANNEL_UNAVAILABLE` instead of fabricating a
 * delivered message.
 */
import { describe, expect, it } from "@jest/globals";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import {
  createMastraChannelTriggerStepHandlers,
  GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS,
} from "../../../src/mastra/MastraChannelTrigger";
import {
  createMastraChannelResponseStepHandlers,
  GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS,
} from "../../../src/mastra/MastraChannelResponse";
import { GRAPH_MASTRA_CHANNEL_UNAVAILABLE } from "../../../src/mastra/types";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { document, node } from "../../../src/workflows/builders";

interface ExecutableStep {
  execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
}

function compileStep(
  kind: string,
  parameters: Record<string, unknown>,
  handlers: ReturnType<
    | typeof createMastraChannelTriggerStepHandlers
    | typeof createMastraChannelResponseStepHandlers
  >
): ExecutableStep {
  const source: GraphWorkflowDocument = document({
    id: `saa-1144-${kind.replace(/\./g, "-")}`,
    name: `saa-1144-${kind}`,
    nodes: [node("target", kind, parameters)],
  });
  const compiler = new MastraWorkflowCompiler({
    stepHandlers: handlers as never,
  });
  const { steps } = compiler.compile(source);
  return steps.get("target") as unknown as ExecutableStep;
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as { graphCode?: string } | undefined)?.graphCode;
}

const GATE =
  "skip — no live Discord/Telegram/Teams credential (mastra adapter is host-supplied)";

describe(`mastra channel triggers — credential-gated (${GATE})`, () => {
  const handlers = createMastraChannelTriggerStepHandlers();

  for (const kind of GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS) {
    it(`${kind} fails closed without a host adapter`, async () => {
      const step = compileStep(
        kind,
        { threadId: "saa1144-live-thread" },
        handlers
      );
      const error = await step
        .execute({ inputData: { message: "hello from the matrix" } })
        .catch((caught: unknown) => caught);
      expect(errorCodeOf(error)).toBe(GRAPH_MASTRA_CHANNEL_UNAVAILABLE);
    });
  }
});

describe(`mastra channel responses — credential-gated (${GATE})`, () => {
  const handlers = createMastraChannelResponseStepHandlers();

  for (const kind of GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS) {
    it(`${kind} fails closed without a host adapter`, async () => {
      const step = compileStep(
        kind,
        { threadId: "saa1144-live-thread" },
        handlers
      );
      const error = await step
        .execute({ inputData: { response: "reply from the matrix" } })
        .catch((caught: unknown) => caught);
      expect(errorCodeOf(error)).toBe(GRAPH_MASTRA_CHANNEL_UNAVAILABLE);
    });
  }
});
