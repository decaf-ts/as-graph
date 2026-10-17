/**
 * @module as-graph/tests/unit/graph/mastra/MastraChannelStepHandlers
 * @summary Unit tests for the SAA-836 M6 mastra channel trigger/response step
 * handlers (`core.agent.trigger.*`, `core.agent.response.*`).
 * @description Pins the kind sets (one trigger and one response kind per
 * platform), the R9 descriptor resolution (platform from the kind, configured
 * conversation binding, workflow/node ids), the step contracts — the trigger
 * forwards the inbound conversation payload (`message`/`sessionId`/`userId`/
 * `threadId`) from the run input onto its outputs with the resolved adapter on
 * `resource`, and the response posts the wired reply + thread binding through
 * the host delivery factory returning the posted reply on `resource` — and the
 * fail-closed paths (`GRAPH_MASTRA_CHANNEL_UNAVAILABLE` without a host surface
 * or when the host resolves nothing).
 */
import { describe, it, expect } from "@jest/globals";
import {
  createMastraChannelTriggerStepHandler,
  createMastraChannelTriggerStepHandlers,
  GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS,
  GRAPH_MASTRA_CHANNEL_TRIGGER_KIND_PREFIX,
  mastraChannelTriggerDescriptorOf,
  mastraChannelTriggerKindOf,
} from "../../../../src/mastra/MastraChannelTrigger";
import {
  createMastraChannelResponseStepHandler,
  createMastraChannelResponseStepHandlers,
  GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS,
  GRAPH_MASTRA_CHANNEL_RESPONSE_KIND_PREFIX,
  mastraChannelResponseDescriptorOf as responseDescriptorOf,
  mastraChannelResponseKindOf,
} from "../../../../src/mastra/MastraChannelResponse";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  MASTRA_CHANNEL_PLATFORMS,
  type MastraNodeStepHandler,
} from "../../../../src/mastra/types";
import type { GraphNodeInstance } from "../../../../src/shared/graph/document/GraphNodeInstance";
import { document, node } from "../../../../src/workflows/builders";
import { graphCodeOf } from "./helpers";

/** A minimal document node instance for descriptor tests. */
function nodeInstance(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {}
): GraphNodeInstance {
  return { id, kind, parameters } as unknown as GraphNodeInstance;
}

/** Compiles a single channel node and returns its executable step. */
function compileChannelStep(
  kind: string,
  parameters: Record<string, unknown> = {},
  handlers: MastraNodeStepHandler[]
): {
  execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
} {
  const compiler = new MastraWorkflowCompiler({ stepHandlers: handlers });
  const compiled = compiler.compile(
    document({
      id: `saa-836-m6-${kind}`,
      name: `saa-836-m6-${kind}`,
      nodes: [node("target", kind, parameters)],
    })
  );
  return compiled.steps.get("target") as {
    execute: (args: {
      inputData?: unknown;
    }) => Promise<Record<string, unknown>>;
  };
}

describe("channel kind sets (SAA-836 M6)", () => {
  it("derives one trigger and one response kind per platform, in platform order", () => {
    expect(MASTRA_CHANNEL_PLATFORMS).toEqual([
      "slack",
      "discord",
      "telegram",
      "teams",
    ]);
    expect(GRAPH_MASTRA_CHANNEL_TRIGGER_KIND_PREFIX).toBe("core.agent.trigger.");
    expect(GRAPH_MASTRA_CHANNEL_RESPONSE_KIND_PREFIX).toBe("core.agent.response.");
    for (const platform of MASTRA_CHANNEL_PLATFORMS) {
      expect(mastraChannelTriggerKindOf(platform)).toBe(
        `core.agent.trigger.${platform}`
      );
      expect(mastraChannelResponseKindOf(platform)).toBe(
        `core.agent.response.${platform}`
      );
    }
    expect(GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS).toEqual([
      "core.agent.trigger.slack",
      "core.agent.trigger.discord",
      "core.agent.trigger.telegram",
      "core.agent.trigger.teams",
    ]);
    expect(GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS).toEqual([
      "core.agent.response.slack",
      "core.agent.response.discord",
      "core.agent.response.telegram",
      "core.agent.response.teams",
    ]);
  });

  it("builds one handler per kind with no options", () => {
    const triggerHandlers = createMastraChannelTriggerStepHandlers();
    const responseHandlers = createMastraChannelResponseStepHandlers();
    expect(triggerHandlers.map((handler) => handler.kind)).toEqual([
      ...GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS,
    ]);
    expect(responseHandlers.map((handler) => handler.kind)).toEqual([
      ...GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS,
    ]);
  });
});

describe("channel trigger descriptors (SAA-836 M6)", () => {
  it("resolves platform, configured thread binding and workflow/node ids", () => {
    expect(
      mastraChannelTriggerDescriptorOf(
        nodeInstance("in", "core.agent.trigger.slack", {
          threadId: "C123",
        }),
        "wf-1"
      )
    ).toEqual({
      platform: "slack",
      threadId: "C123",
      workflowId: "wf-1",
      nodeId: "in",
    });
  });

  it("omits an empty thread binding and carries no workflowId when none is given", () => {
    expect(
      mastraChannelTriggerDescriptorOf(nodeInstance("in", "core.agent.trigger.telegram"))
    ).toEqual({ platform: "telegram", nodeId: "in" });
    expect(
      mastraChannelTriggerDescriptorOf(
        nodeInstance("in", "core.agent.trigger.telegram", { threadId: "   " })
      ).threadId
    ).toBeUndefined();
  });

  it("fails closed with GRAPH_MASTRA_CHANNEL_UNAVAILABLE for an unknown platform", () => {
    expect(
      graphCodeOf(() =>
        mastraChannelTriggerDescriptorOf(
          nodeInstance("in", "core.agent.trigger.irc")
        )
      )
    ).toBe(GRAPH_MASTRA_CHANNEL_UNAVAILABLE);
  });
});

describe("channel trigger steps (SAA-836 M6)", () => {
  it("forwards the inbound conversation payload from the run input onto the outputs", async () => {
    const adapters: unknown[] = [];
    const step = compileChannelStep(
      "core.agent.trigger.slack",
      { threadId: "C123" },
      createMastraChannelTriggerStepHandlers({
        resolveChannelAdapter: (descriptor) => {
          adapters.push(descriptor);
          return { platform: "slack", adapter: true };
        },
      })
    );

    const output = await step.execute({
      inputData: {
        message: "hello",
        sessionId: "s-1",
        userId: "u-1",
        threadId: "C123",
      },
    });

    expect(output).toEqual({
      message: "hello",
      sessionId: "s-1",
      userId: "u-1",
      threadId: "C123",
      resource: { platform: "slack", adapter: true },
    });
    expect(adapters).toHaveLength(1);
  });

  it("falls the thread binding back to the configured binding and nulls missing payload fields", async () => {
    const step = compileChannelStep(
      "core.agent.trigger.teams",
      { threadId: "configured-thread" },
      createMastraChannelTriggerStepHandlers({
        resolveChannelAdapter: () => ({ adapter: true }),
      })
    );

    const output = await step.execute({ inputData: { message: "hi" } });

    expect(output).toEqual({
      message: "hi",
      sessionId: null,
      userId: null,
      threadId: "configured-thread",
      resource: { adapter: true },
    });
  });

  it("fails closed with GRAPH_MASTRA_CHANNEL_UNAVAILABLE without a host adapter factory", async () => {
    const step = compileChannelStep(
      "core.agent.trigger.slack",
      {},
      createMastraChannelTriggerStepHandlers()
    );

    await expect(step.execute({ inputData: { message: "hi" } })).rejects.toMatchObject(
      { graphCode: GRAPH_MASTRA_CHANNEL_UNAVAILABLE }
    );
  });

  it("fails closed when the host adapter factory resolves nothing", async () => {
    for (const resolved of [undefined, null]) {
      const step = compileChannelStep(
        "core.agent.trigger.slack",
        {},
        createMastraChannelTriggerStepHandlers({
          resolveChannelAdapter: () => resolved,
        })
      );
      await expect(
        step.execute({ inputData: { message: "hi" } })
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_CHANNEL_UNAVAILABLE });
    }
  });
});

describe("channel response descriptors (SAA-836 M6)", () => {
  it("resolves platform, configured thread binding and workflow/node ids", () => {
    expect(
      responseDescriptorOf(
        nodeInstance("out", "core.agent.response.discord", {
          threadId: "ch-9",
        }),
        "wf-2"
      )
    ).toEqual({
      platform: "discord",
      threadId: "ch-9",
      workflowId: "wf-2",
      nodeId: "out",
    });
  });

  it("fails closed with GRAPH_MASTRA_CHANNEL_UNAVAILABLE for an unknown platform", () => {
    expect(
      graphCodeOf(() =>
        responseDescriptorOf(
          nodeInstance("out", "core.agent.response.pagerduty")
        )
      )
    ).toBe(GRAPH_MASTRA_CHANNEL_UNAVAILABLE);
  });

});

describe("channel response steps (SAA-836 M6)", () => {
  it("posts the wired reply and thread binding through the host delivery factory", async () => {
    const posted: Array<{
      descriptor: unknown;
      payload: Record<string, unknown>;
    }> = [];
    const postedReply = { tagged: "posted-reply" };
    const step = compileChannelStep(
      "core.agent.response.slack",
      {},
      createMastraChannelResponseStepHandlers({
        sendChannelResponse: (descriptor, payload) => {
          posted.push({ descriptor, payload });
          return postedReply;
        },
      })
    );

    const output = await step.execute({
      inputData: { response: "the reply", threadId: "wired-thread" },
    });

    expect(output).toEqual({ resource: postedReply });
    expect(posted).toEqual([
      {
        descriptor: expect.objectContaining({
          platform: "slack",
          nodeId: "target",
        }),
        payload: { response: "the reply", threadId: "wired-thread" },
      },
    ]);
  });

  it("falls the thread binding back to the configured binding and nulls it when none is known", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const step = compileChannelStep(
      "core.agent.response.telegram",
      { threadId: "configured-chat" },
      createMastraChannelResponseStepHandlers({
        sendChannelResponse: (_descriptor, payload) => {
          payloads.push(payload);
          return { ok: true };
        },
      })
    );

    const withConfigured = await step.execute({
      inputData: { response: "r" },
    });
    expect(withConfigured).toEqual({ resource: { ok: true } });
    expect(payloads.at(-1)).toEqual({
      response: "r",
      threadId: "configured-chat",
    });

    const unbound = compileChannelStep(
      "core.agent.response.telegram",
      {},
      createMastraChannelResponseStepHandlers({
        sendChannelResponse: (_descriptor, payload) => {
          payloads.push(payload);
          return { ok: true };
        },
      })
    );
    await unbound.execute({ inputData: { response: "r2" } });
    expect(payloads.at(-1)).toEqual({ response: "r2", threadId: null });
  });

  it("prefers the wired thread binding over the configured binding", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const step = compileChannelStep(
      "core.agent.response.teams",
      { threadId: "configured-channel" },
      createMastraChannelResponseStepHandlers({
        sendChannelResponse: (_descriptor, payload) => {
          payloads.push(payload);
          return { ok: true };
        },
      })
    );
    await step.execute({
      inputData: { response: "r", threadId: "wired-channel" },
    });
    expect(payloads.at(-1)).toEqual({
      response: "r",
      threadId: "wired-channel",
    });
  });

  it("fails closed with GRAPH_MASTRA_CHANNEL_UNAVAILABLE without a host delivery factory", async () => {
    const step = compileChannelStep(
      "core.agent.response.slack",
      {},
      createMastraChannelResponseStepHandlers()
    );

    await expect(
      step.execute({ inputData: { response: "the reply" } })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_CHANNEL_UNAVAILABLE });
  });

  it("fails closed when the host delivery factory resolves nothing", async () => {
    for (const posted of [undefined, null]) {
      const step = compileChannelStep(
        "core.agent.response.slack",
        {},
        createMastraChannelResponseStepHandlers({
          sendChannelResponse: () => posted,
        })
      );
      await expect(
        step.execute({ inputData: { response: "the reply" } })
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_CHANNEL_UNAVAILABLE });
    }
  });
});

describe("single-kind handler factories (SAA-836 M6)", () => {
  it("builds a handler bound to the given trigger kind", async () => {
    const handler = createMastraChannelTriggerStepHandler(
      "core.agent.trigger.telegram",
      { resolveChannelAdapter: () => ({ tg: true }) }
    );
    expect(handler.kind).toBe("core.agent.trigger.telegram");
    const step = compileChannelStep(
      "core.agent.trigger.telegram",
      {},
      [handler]
    );
    const output = await step.execute({ inputData: { message: "ciao" } });
    expect(output.resource).toEqual({ tg: true });
  });

  it("builds a handler bound to the given response kind", async () => {
    const handler = createMastraChannelResponseStepHandler(
      "core.agent.response.teams",
      { sendChannelResponse: () => ({ posted: true }) }
    );
    expect(handler.kind).toBe("core.agent.response.teams");
    const step = compileChannelStep(
      "core.agent.response.teams",
      {},
      [handler]
    );
    const output = await step.execute({ inputData: { response: "r" } });
    expect(output.resource).toEqual({ posted: true });
  });
});
