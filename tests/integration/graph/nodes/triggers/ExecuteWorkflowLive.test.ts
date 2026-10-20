/**
 * @module as-graph/tests/integration/graph/nodes/triggers/ExecuteWorkflowLive
 * @summary SAA-1144 live integration coverage for
 * `core.trigger.executeWorkflow`.
 * @description Executes the production trigger node through the shared
 * `runNode` harness with the payload a parent `core.flow.executeSubWorkflow`
 * node delivers, plus the documented fallbacks. This kind has no external
 * service dependency; the real node contract is the payload projection.
 */
import { describe, expect, it } from "@jest/globals";
import { ExecuteWorkflowTriggerNode } from "../../../../../src/node/triggers/execute-workflow/node";
import { runNode } from "../real-service-support";

const KIND = "core.trigger.executeWorkflow";
const LIVE_BACKING = "in-process real node (sub-workflow payload trigger)";

describe(`core.trigger.executeWorkflow — live node (${LIVE_BACKING})`, () => {
  it("emits the parent sub-workflow payload as the result", async () => {
    const payload = {
      orderId: "ord-1",
      lines: [{ sku: "A", qty: 2 }],
    };
    const result = await runNode(
      ExecuteWorkflowTriggerNode,
      KIND,
      { schema: { type: "object" } },
      { payload }
    );
    expect(result.result).toEqual(payload);
  });

  it("falls back to the value input, then to the whole input map", async () => {
    expect(
      (
        await runNode(ExecuteWorkflowTriggerNode, KIND, {}, { value: "routed" })
      ).result
    ).toBe("routed");

    expect(
      (await runNode(ExecuteWorkflowTriggerNode, KIND, {}, { a: 1, b: 2 }))
        .result
    ).toEqual({ a: 1, b: 2 });
  });

  it("emits undefined when the parent delivered no payload at all", async () => {
    const result = await runNode(ExecuteWorkflowTriggerNode, KIND, {}, {});
    expect(result.result).toEqual({});
  });
});
