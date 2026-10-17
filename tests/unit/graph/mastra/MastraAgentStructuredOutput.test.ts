/**
 * @module as-graph/tests/unit/graph/mastra/MastraAgentStructuredOutput
 * @summary Driver tests for the `core.agent` structured-output wiring
 * (SAA-836 S1, SAA-877).
 * @description Proves the step handler resolves the node's structured-output
 * definition (memoized per step) and passes it as the sixth argument of
 * `MastraAgentRuntime.execute`, that a declared definition which cannot
 * resolve fails closed with `GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED`, and
 * that the config-backed runtime applies the resolved option as mastra's
 * per-run `structuredOutput` generate option — with no `structuredOutput` key
 * set when the node declares none.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { Model, model, min, required } from "@decaf-ts/decorator-validation";
import type { z } from "zod";
import {
  createMastraAgentRuntimeFromConfig,
  createMastraAgentStepHandler,
  type MastraAgentRuntime,
} from "../../../../src/mastra/MastraAgentStepHandler";
import { mastraSchemaFromModel } from "../../../../src/mastra/MastraModelSchemaConverter";
import {
  GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
  type MastraResolvedStructuredOutput,
} from "../../../../src/mastra/MastraStructuredOutput";
import { node } from "../../../../src/workflows/builders";

/** A decorated decaf model used as the registry-resolved schema source. */
@model()
class OrderModel extends Model {
  constructor() {
    super();
    this.reference = "";
    this.total = 0;
  }

  @required()
  reference!: string;

  @min(0)
  total!: number;
}

/** A host registry resolving one decaf model name. */
function resolveModel(name: string) {
  return name === "OrderModel" ? OrderModel : undefined;
}

/** A deterministic fake mastra agent with a `generate` spy. */
function fakeAgent() {
  return { generate: jest.fn(async () => ({ text: "ok" })) };
}

describe("core.agent structured-output wiring (SAA-836 S1)", () => {
  it("passes the resolved structured output as the 6th argument of runtime.execute", async () => {
    const executes: unknown[][] = [];
    const runtime: MastraAgentRuntime = {
      execute: (async (...args: unknown[]) => {
        executes.push(args);
        return { response: "ok", actions: [] };
      }) as MastraAgentRuntime["execute"],
    };
    const handler = createMastraAgentStepHandler({ runtime, resolveModel });
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: "OrderModel" },
    });

    const step = handler.createStep(subject, { stepId: "agent-1" }) as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };
    await step.execute({ inputData: { prompt: "hi" } });

    expect(executes).toHaveLength(1);
    expect(executes[0]).toHaveLength(6);
    const structuredOutput = executes[0][5] as MastraResolvedStructuredOutput;
    expect(
      Object.keys((structuredOutput.schema as z.ZodObject).shape).sort()
    ).toEqual(["reference", "total"]);
  });

  it("passes no structured output when the node declares none", async () => {
    const executes: unknown[][] = [];
    const runtime: MastraAgentRuntime = {
      execute: (async (...args: unknown[]) => {
        executes.push(args);
        return { response: "ok", actions: [] };
      }) as MastraAgentRuntime["execute"],
    };
    const handler = createMastraAgentStepHandler({ runtime, resolveModel });
    const subject = node("agent-1", "core.agent", { prompt: "hi" });

    const step = handler.createStep(subject, { stepId: "agent-1" }) as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };
    await step.execute({ inputData: { prompt: "hi" } });

    expect(executes[0][5]).toBeUndefined();
  });

  it("memoizes the per-step resolution: the registry is consulted once", async () => {
    let resolveCalls = 0;
    const runtime: MastraAgentRuntime = {
      execute: (async () => ({ response: "ok", actions: [] })) as unknown as MastraAgentRuntime["execute"],
    };
    const handler = createMastraAgentStepHandler({
      runtime,
      resolveModel: (name) => {
        resolveCalls += 1;
        return resolveModel(name);
      },
    });
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: "OrderModel" },
    });
    const step = handler.createStep(subject, { stepId: "agent-1" }) as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };

    await step.execute({ inputData: { prompt: "one" } });
    await step.execute({ inputData: { prompt: "two" } });

    expect(resolveCalls).toBe(1);
  });

  it("fails closed at the step when a declared definition cannot resolve", async () => {
    const runtime: MastraAgentRuntime = {
      execute: (async () => ({ response: "ok", actions: [] })) as unknown as MastraAgentRuntime["execute"],
    };
    const handler = createMastraAgentStepHandler({ runtime });
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: "NoSuchModel" },
    });
    const step = handler.createStep(subject, { stepId: "agent-1" }) as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };

    await expect(step.execute({ inputData: { prompt: "hi" } })).rejects.toMatchObject(
      { graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED }
    );
  });
});

describe("createMastraAgentRuntimeFromConfig structured output (SAA-836 S1)", () => {
  it("applies the resolved option as mastra's per-run structuredOutput generate option", async () => {
    const agent = fakeAgent();
    const runtime = createMastraAgentRuntimeFromConfig({
      agents: { "agent-1": agent },
    });
    const structuredOutput: MastraResolvedStructuredOutput = {
      schema: mastraSchemaFromModel(OrderModel),
      instructions: "Return strict JSON",
      jsonPromptInjection: "inline",
      providerOptions: { temperature: 0.1 },
    };
    const subject = node("agent-1", "core.agent", { prompt: "hi" });

    await runtime.execute(
      subject,
      { prompt: "hi" },
      undefined,
      undefined,
      undefined,
      structuredOutput
    );

    expect(agent.generate).toHaveBeenCalledTimes(1);
    const [prompt, options] = (agent.generate as jest.Mock).mock.calls[0];
    expect(prompt).toBe("hi");
    expect(options).toMatchObject({
      structuredOutput: {
        schema: structuredOutput.schema,
        instructions: "Return strict JSON",
        jsonPromptInjection: "inline",
        providerOptions: { temperature: 0.1 },
      },
    });
  });

  it("sets no structuredOutput key when the node declares none", async () => {
    const agent = fakeAgent();
    const runtime = createMastraAgentRuntimeFromConfig({
      agents: { "agent-1": agent },
    });
    const subject = node("agent-1", "core.agent", { prompt: "hi" });

    await runtime.execute(subject, { prompt: "hi" });

    expect(agent.generate).toHaveBeenCalledTimes(1);
    const [, options] = (agent.generate as jest.Mock).mock.calls[0];
    const structured = (options ?? {})["structuredOutput"];
    expect(structured).toBeUndefined();
  });

  it("end to end: the node's model-name definition reaches generate as a Zod schema", async () => {
    const agent = fakeAgent();
    const runtime = createMastraAgentRuntimeFromConfig({
      agents: { "agent-1": agent },
    });
    const handler = createMastraAgentStepHandler({ runtime, resolveModel });
    const subject = node("agent-1", "core.agent", {
      prompt: "summarize",
      structuredOutput: { model: "OrderModel" },
    });
    const step = handler.createStep(subject, { stepId: "agent-1" }) as {
      execute: (args: { inputData?: unknown }) => Promise<unknown>;
    };

    const output = (await step.execute({
      inputData: { prompt: "summarize" },
    })) as Record<string, unknown>;

    expect(output["response"]).toBe("ok");
    expect(agent.generate).toHaveBeenCalledTimes(1);
    const [, options] = (agent.generate as jest.Mock).mock.calls[0];
    const schema = (options as { structuredOutput: { schema: z.ZodObject } })
      .structuredOutput.schema;
    expect(Object.keys(schema.shape).sort()).toEqual(["reference", "total"]);
  });
});
