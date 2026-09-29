/**
 * @module as-graph/tests/unit/graph/errors.test
 * @summary Unit tests for graph execution error classes.
 */
import { InternalError } from "@decaf-ts/db-decorators";

import {
  GraphExecutionError,
  GraphCycleError,
  GraphInputError,
  GraphLoopLimitError,
  GraphPinningError,
  GraphPortError,
  GraphStoreError,
  GraphTopologyError,
} from "../../../src/engine/errors";

describe("graph errors", () => {
  it("GraphExecutionError extends InternalError with graphCode", () => {
    const err = new GraphExecutionError("boom", "CUSTOM_CODE", { a: 1 });
    expect(err).toBeInstanceOf(InternalError);
    expect(err.graphCode).toBe("CUSTOM_CODE");
    expect(err.details).toEqual({ a: 1 });
    expect(err.message).toContain("boom");
  });

  it("GraphCycleError has GRAPH_CYCLE_ERROR code", () => {
    const err = new GraphCycleError({ nodes: ["a", "b"] });
    expect(err.graphCode).toBe("GRAPH_CYCLE_ERROR");
    expect(err).toBeInstanceOf(GraphExecutionError);
  });

  it("GraphInputError has GRAPH_INPUT_ERROR code", () => {
    const err = new GraphInputError("bad input");
    expect(err.graphCode).toBe("GRAPH_INPUT_ERROR");
  });

  it("GraphLoopLimitError has GRAPH_LOOP_LIMIT_ERROR code", () => {
    const err = new GraphLoopLimitError("too many");
    expect(err.graphCode).toBe("GRAPH_LOOP_LIMIT_ERROR");
  });

  it("GraphPinningError has GRAPH_PINNING_ERROR code", () => {
    const err = new GraphPinningError("cannot pin");
    expect(err.graphCode).toBe("GRAPH_PINNING_ERROR");
  });

  it("GraphPortError has GRAPH_PORT_ERROR code", () => {
    const err = new GraphPortError("bad port");
    expect(err.graphCode).toBe("GRAPH_PORT_ERROR");
  });

  it("GraphStoreError has GRAPH_STORE_ERROR code", () => {
    const err = new GraphStoreError("store fail");
    expect(err.graphCode).toBe("GRAPH_STORE_ERROR");
  });

  it("GraphTopologyError has GRAPH_TOPOLOGY_ERROR code", () => {
    const err = new GraphTopologyError("bad topology");
    expect(err.graphCode).toBe("GRAPH_TOPOLOGY_ERROR");
  });
});
