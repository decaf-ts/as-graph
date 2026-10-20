/**
 * @module as-graph/tests/integration/graph/nodes/GeneralEngineFlowLive
 * @summary SAA-1144 integration coverage for the remaining general-engine
 * kinds that had no integration execution: the trigger family, the flow-control
 * family, the utility map/log nodes, and the while/until/break loop controls.
 * @description Executes the production node classes. The trigger/utility/flow
 * nodes run through the shared `runNode` harness; the loop nodes receive the
 * real `loop`/`engine` execution surface through `buildNodeContext`, with the
 * loop body supplied by the same recording engine double the unit suite uses.
 * No external service is involved in these kinds.
 */
import { describe, expect, it } from "@jest/globals";
import { GraphInputValueNode } from "../../../../src/node/boundary/input/node";
import { GraphOutputValueNode } from "../../../../src/node/boundary/output/node";
import { ManualTriggerNode } from "../../../../src/node/triggers/manual/node";
import { WebhookTriggerNode } from "../../../../src/node/triggers/webhook/node";
import { ScheduleTriggerNode } from "../../../../src/node/triggers/schedule/node";
import { EventTriggerNode } from "../../../../src/node/triggers/event/node";
import { FormTriggerNode } from "../../../../src/node/triggers/form/node";
import { IfFlowNode } from "../../../../src/node/flow/if/node";
import { ErrorBoundaryFlowNode } from "../../../../src/node/flow/error-boundary/node";
import { LogFlowNode } from "../../../../src/node/utility/log/node";
import { BreakFlowNode } from "../../../../src/node/flow/break/node";
import { MapNode } from "../../../../src/node/utility/map/node";
import { UtilityLogNode } from "../../../../src/node/utility/utility-log/node";
import { GraphWhileLoopNode } from "../../../../src/node/flow/loop/while/node";
import { GraphUntilLoopNode } from "../../../../src/node/flow/loop/until/node";
import { GraphBreakSignal } from "../../../../src/engine/errors/GraphBreakSignal";
import { executeNode, nodeExecutionRequest } from "../../../unit/graph/engine-fixtures";
import {
  buildNodeContext,
  loopEngine,
} from "../../../unit/graph/nodes/node-test-utils";
import { errorCodeOf, runNode } from "./real-service-support";

const LIVE_BACKING = "in-process real node (general engine; no external service)";

function incrementEngine(): ReturnType<typeof loopEngine> {
  return loopEngine((inputs) => {
    const state = inputs["state"] as { n: number };
    return { state: { n: state.n + 1 } };
  });
}

describe(`value/result boundary — live nodes (${LIVE_BACKING})`, () => {
  it("forwards the workflow input and output boundary values", async () => {
    expect(
      (await runNode(GraphInputValueNode, "value", {}, { value: "wf-input" }))
        .value
    ).toBe("wf-input");
    expect(
      await runNode(GraphOutputValueNode, "result", {}, { value: "wf-output" })
    ).toEqual({});
  });
});

describe(`trigger family — live nodes (${LIVE_BACKING})`, () => {
  const payloads: Array<{
    kind: string;
    nodeClass: typeof ManualTriggerNode;
    parameters?: Record<string, unknown>;
  }> = [
    { kind: "core.trigger.manual", nodeClass: ManualTriggerNode },
    { kind: "core.trigger.webhook", nodeClass: WebhookTriggerNode },
    {
      kind: "core.trigger.schedule",
      nodeClass: ScheduleTriggerNode,
      parameters: { cron: "0 * * * *" },
    },
    { kind: "core.trigger.event", nodeClass: EventTriggerNode },
    { kind: "core.trigger.form", nodeClass: FormTriggerNode },
  ];

  for (const { kind, nodeClass, parameters } of payloads) {
    it(`${kind} forwards the runtime payload`, async () => {
      const payload = { id: `${kind}-1`, body: { ok: true } };
      const result = await runNode(nodeClass, kind, parameters ?? {}, { payload });
      expect(result).toEqual({ payload });
    });
  }
});

describe(`core.flow.if — live node (${LIVE_BACKING})`, () => {
  it("routes to then/else on a real condition", async () => {
    const thenResult = await runNode(
      IfFlowNode,
      "core.flow.if",
      { condition: { op: "eq", left: { path: "n" }, right: { const: 2 } } },
      { value: { n: 2 } }
    );
    expect(thenResult).toEqual({ then: { n: 2 } });

    const elseResult = await runNode(
      IfFlowNode,
      "core.flow.if",
      {
        condition: { op: "eq", left: { path: "n" }, right: { const: 2 } },
        else: true,
      },
      { value: { n: 3 } }
    );
    expect(elseResult).toEqual({ else: { n: 3 } });
  });

  it("fails closed without a condition", async () => {
    const error = await runNode(
      IfFlowNode,
      "core.flow.if",
      {},
      { value: "x" }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_IF_NO_CONDITION");
  });
});

describe(`core.flow.errorBoundary / log — live nodes (${LIVE_BACKING})`, () => {
  it("passes the value through and forwards log output", async () => {
    const bounded = await runNode(
      ErrorBoundaryFlowNode,
      "core.flow.errorBoundary",
      {},
      { value: { stage: "ok" } }
    );
    expect(bounded).toEqual({ result: { stage: "ok" } });

    const logged = await runNode(
      LogFlowNode,
      "core.flow.log",
      { level: "info", message: "saa-1144" },
      { value: 42 }
    );
    expect(logged.value).toBe(42);

    const utilityLogged = await runNode(
      UtilityLogNode,
      "core.utility.log",
      { level: "info", message: "saa-1144-utility" },
      { value: "kept" }
    );
    expect(utilityLogged.value).toBe("kept");
  });
});

describe(`core.utility.map — live node (${LIVE_BACKING})`, () => {
  it("maps the routed value into a result object", async () => {
    const result = await runNode(MapNode, "core.utility.map", {}, { value: { a: 1 } });
    expect(result.result).toEqual({ mapped: { a: 1 } });
  });
});

describe(`core.loop.while / until — live nodes (${LIVE_BACKING})`, () => {
  it("runs the while body until the condition fails", async () => {
    const context = buildNodeContext("core.loop.while", {
      parameters: { condition: { type: "lessThan", left: "n", right: 2 } },
      loop: { body: {} as never },
      engine: incrementEngine(),
    });
    const result = await executeNode(
      GraphWhileLoopNode,
      nodeExecutionRequest({ state: { n: 0 } }),
      context
    );
    expect(result).toEqual({ state: { n: 2 }, iterations: 2 });
  });

  it("runs the until body at least once", async () => {
    const context = buildNodeContext("core.loop.until", {
      parameters: {
        condition: { type: "greaterThanOrEqual", left: "n", right: 2 },
      },
      loop: { body: {} as never },
      engine: incrementEngine(),
    });
    const result = await executeNode(
      GraphUntilLoopNode,
      nodeExecutionRequest({ state: { n: 5 } }),
      context
    );
    expect(result).toEqual({ state: { n: 6 }, iterations: 1 });
  });
});

describe(`core.flow.break — live node (${LIVE_BACKING})`, () => {
  it("raises a break signal carrying the routed value", async () => {
    const error = await runNode(
      BreakFlowNode,
      "core.flow.break",
      {},
      { value: { stopAt: 3 } }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphBreakSignal);
    expect((error as GraphBreakSignal).details).toEqual({
      value: { stopAt: 3 },
    });
  });
});
