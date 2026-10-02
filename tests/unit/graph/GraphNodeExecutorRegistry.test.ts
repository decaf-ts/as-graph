/**
 * @module as-graph/tests/unit/graph/GraphNodeExecutorRegistry.test
 * @summary Unit tests for the graph node executor registry.
 */
import { jest } from "@jest/globals";
import { Context } from "@decaf-ts/core";

import { GraphNodeExecutorRegistry } from "../../../src/engine/registry";
import { GraphExecutionError } from "../../../src/engine/errors";
import type { GraphNodeExecutor } from "../../../src/engine/execution";

describe("GraphNodeExecutorRegistry", () => {
  it("register adds an executor and has returns true", () => {
    const registry = new GraphNodeExecutorRegistry();
    const ctx = new Context();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor, ctx);
    expect(registry.has("math.add", ctx)).toBe(true);
  });

  it("unregister removes an executor", () => {
    const registry = new GraphNodeExecutorRegistry();
    const ctx = new Context();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor, ctx);
    registry.unregister("math.add", ctx);
    expect(registry.has("math.add", ctx)).toBe(false);
  });

  it("resolve returns the registered executor", () => {
    const registry = new GraphNodeExecutorRegistry();
    const ctx = new Context();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    registry.register("math.add", executor, ctx);
    expect(registry.resolve("math.add", ctx)).toBe(executor);
  });

  it("resolve throws GraphExecutionError for unknown kind", () => {
    const registry = new GraphNodeExecutorRegistry();
    const ctx = new Context();
    expect(() => registry.resolve("unknown.kind", ctx)).toThrow(
      GraphExecutionError
    );
  });

  it("register throws for empty kind", () => {
    const registry = new GraphNodeExecutorRegistry();
    const ctx = new Context();
    const executor: GraphNodeExecutor = { execute: jest.fn() };
    expect(() => registry.register("", executor, ctx)).toThrow(
      GraphExecutionError
    );
  });
});
