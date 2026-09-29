/**
 * @module as-graph/tests/unit/graph/GraphNodeExecutorRegistry.test
 * @summary Unit tests for the graph node executor registry.
 */
import { jest } from "@jest/globals";

import { GraphNodeExecutorRegistry } from "../../../src/engine/registry";
import { GraphExecutionError } from "../../../src/engine/errors";
import type { GraphNodeExecutor } from "../../../src/engine/execution";

describe("GraphNodeExecutorRegistry", () => {
  it("register adds an executor and has returns true", () => {
    const registry = new GraphNodeExecutorRegistry();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor);
    expect(registry.has("math.add")).toBe(true);
  });

  it("unregister removes an executor", () => {
    const registry = new GraphNodeExecutorRegistry();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor);
    registry.unregister("math.add");
    expect(registry.has("math.add")).toBe(false);
  });

  it("resolve returns the registered executor", () => {
    const registry = new GraphNodeExecutorRegistry();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor);
    expect(registry.resolve("math.add")).toBe(executor);
  });

  it("resolve throws GraphExecutionError for unknown kind", () => {
    const registry = new GraphNodeExecutorRegistry();
    expect(() => registry.resolve("unknown.kind")).toThrow(GraphExecutionError);
  });

  it("register throws for empty kind", () => {
    const registry = new GraphNodeExecutorRegistry();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    expect(() => registry.register("", executor)).toThrow(GraphExecutionError);
  });
});
