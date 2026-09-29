/**
 * @module as-graph/tests/unit/graph/IsolatedVmCodeSandboxEvaluator.test
 * @summary Unit tests for the `isolated-vm`-backed code sandbox evaluator.
 */
import { jest } from "@jest/globals";

import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import type {
  CodeSandboxContext,
  SandboxLogger,
} from "../../../src/engine/execution/CodeSandboxEvaluator";

interface SpyLogger extends SandboxLogger {
  info: ReturnType<typeof jest.fn>;
  error: ReturnType<typeof jest.fn>;
  warn: ReturnType<typeof jest.fn>;
  debug: ReturnType<typeof jest.fn>;
  trace: ReturnType<typeof jest.fn>;
}

/** Builds a fully-spied {@link SandboxLogger} for the console-forwarding assertions. */
function createSpyLogger(): SpyLogger {
  return {
    benchmark: jest.fn(),
    fatal: jest.fn(),
    critical: jest.fn(),
    silly: jest.fn(),
    verbose: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    trace: jest.fn(),
  };
}

describe("IsolatedVmCodeSandboxEvaluator", () => {
  const evaluator = new IsolatedVmCodeSandboxEvaluator();

  describe("expression mode (no return statement)", () => {
    it("evaluates a simple arithmetic expression", async () => {
      const ctx: CodeSandboxContext = {
        code: "$input.a + $input.b",
        input: { a: 2, b: 3 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(5);
    });

    it("evaluates an object literal expression", async () => {
      const ctx: CodeSandboxContext = {
        code: "({ sum: $input.a + $input.b, label: $input.label })",
        input: { a: 1, b: 4, label: "total" },
      };
      expect(await evaluator.evaluate(ctx)).toEqual({
        sum: 5,
        label: "total",
      });
    });

    it("evaluates a ternary expression", async () => {
      const ctx: CodeSandboxContext = {
        code: "$input.value > 10 ? 'big' : 'small'",
        input: { value: 15 },
      };
      expect(await evaluator.evaluate(ctx)).toBe("big");
    });
  });

  describe("statement mode (with return statement)", () => {
    it("executes a function with an explicit return", async () => {
      const ctx: CodeSandboxContext = {
        code: "const total = $input.a + $input.b; return total * 2;",
        input: { a: 3, b: 4 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(14);
    });

    it("supports if/else blocks", async () => {
      const ctx: CodeSandboxContext = {
        code: "if ($input.value > 10) { return 'big'; } else { return 'small'; }",
        input: { value: 5 },
      };
      expect(await evaluator.evaluate(ctx)).toBe("small");
    });

    it("supports array map with a return", async () => {
      const ctx: CodeSandboxContext = {
        code: "return $input.items.map(function(x) { return x * 2; });",
        input: { items: [1, 2, 3] },
      };
      expect(await evaluator.evaluate(ctx)).toEqual([2, 4, 6]);
    });

    it("supports async/await", async () => {
      const ctx: CodeSandboxContext = {
        code: "const v = await Promise.resolve($input.a); return v + 1;",
        input: { a: 10 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(11);
    });
  });

  describe("TypeScript support", () => {
    it("transpiles and executes TS code", async () => {
      const ctx: CodeSandboxContext = {
        code: "const x: number = $input.a; const y: number = $input.b; return x + y;",
        language: "typescript",
        input: { a: 5, b: 7 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(12);
    });

    it("transpiles TS interfaces and types", async () => {
      const ctx: CodeSandboxContext = {
        code: "interface Point { x: number; y: number } const p: Point = $input; return p.x + p.y;",
        language: "typescript",
        input: { x: 3, y: 4 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(7);
    });

    it("transpiles TS expression mode", async () => {
      const ctx: CodeSandboxContext = {
        code: "($input.a as number) + ($input.b as number)",
        language: "typescript",
        input: { a: 2, b: 8 },
      };
      expect(await evaluator.evaluate(ctx)).toBe(10);
    });
  });

  describe("sandbox data variables", () => {
    it("exposes $input", async () => {
      const ctx: CodeSandboxContext = {
        code: "return $input;",
        input: { foo: "bar" },
      };
      expect(await evaluator.evaluate(ctx)).toEqual({ foo: "bar" });
    });

    it("exposes $vars", async () => {
      const ctx: CodeSandboxContext = {
        code: "return $vars.topic;",
        input: {},
        vars: { topic: "hello" },
      };
      expect(await evaluator.evaluate(ctx)).toBe("hello");
    });

    it("exposes $item and $index", async () => {
      const ctx: CodeSandboxContext = {
        code: "return { item: $item, index: $index };",
        input: {},
        item: "apple",
        index: 2,
      };
      expect(await evaluator.evaluate(ctx)).toEqual({
        item: "apple",
        index: 2,
      });
    });

    it("exposes $node outputs", async () => {
      const ctx: CodeSandboxContext = {
        code: 'return $node["Research"].output.summary;',
        input: {},
        nodes: {
          Research: { output: { summary: "found it" } },
        },
      };
      expect(await evaluator.evaluate(ctx)).toBe("found it");
    });

    it("provides empty objects for missing variables", async () => {
      const ctx: CodeSandboxContext = {
        code: "return { input: $input, vars: $vars, node: $node };",
        input: undefined as unknown as Record<string, unknown>,
      };
      const result = await evaluator.evaluate(ctx) as Record<string, unknown>;
      expect(result["input"]).toEqual({});
      expect(result["vars"]).toEqual({});
      expect(result["node"]).toEqual({});
    });
  });

  describe("restrictions (no imports, no requires, pure functions)", () => {
    it("rejects require()", async () => {
      const ctx: CodeSandboxContext = {
        code: "require('fs')",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "require".*not allowed/i
      );
    });

    it("rejects import statements", async () => {
      const ctx: CodeSandboxContext = {
        code: "import fs from 'fs'",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Imports are not allowed/i
      );
    });

    it("rejects export statements", async () => {
      const ctx: CodeSandboxContext = {
        code: "export const x = 1",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Exports are not allowed/i
      );
    });

    it("rejects process global", async () => {
      const ctx: CodeSandboxContext = {
        code: "process.env",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "process".*not allowed/i
      );
    });

    it("rejects global access", async () => {
      const ctx: CodeSandboxContext = {
        code: "global.foo",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "global".*not allowed/i
      );
    });

    it("rejects globalThis", async () => {
      const ctx: CodeSandboxContext = {
        code: "globalThis.foo",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "globalThis".*not allowed/i
      );
    });

    it("rejects eval()", async () => {
      const ctx: CodeSandboxContext = {
        code: "eval('1+1')",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "eval".*not allowed/i
      );
    });

    it("rejects new Function()", async () => {
      const ctx: CodeSandboxContext = {
        code: "new Function('return 1')()",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "Function".*not allowed/i
      );
    });

    it("rejects fetch", async () => {
      const ctx: CodeSandboxContext = {
        code: "fetch('http://example.com')",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "fetch".*not allowed/i
      );
    });

    it("rejects module references", async () => {
      const ctx: CodeSandboxContext = {
        code: "module.exports = {}",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "module".*not allowed/i
      );
    });

    it("rejects WebSocket", async () => {
      const ctx: CodeSandboxContext = {
        code: "new WebSocket('ws://x')",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "WebSocket".*not allowed/i
      );
    });

    it("does not expose setTimeout in the sandbox", async () => {
      const ctx: CodeSandboxContext = {
        code: "return typeof setTimeout === 'undefined' ? 'safe' : 'leaked';",
        input: {},
      };
      expect(await evaluator.evaluate(ctx)).toBe("safe");
    });

    it("blocks process references even in typeof checks", async () => {
      const ctx: CodeSandboxContext = {
        code: "typeof process",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "process".*not allowed/i
      );
    });

    it("blocks require references even in typeof checks", async () => {
      const ctx: CodeSandboxContext = {
        code: "typeof require",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /Identifier "require".*not allowed/i
      );
    });
  });

  describe("error handling", () => {
    it("throws on empty code", async () => {
      const ctx: CodeSandboxContext = {
        code: "",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(/empty code/i);
    });

    it("throws on whitespace-only code", async () => {
      const ctx: CodeSandboxContext = {
        code: "   ",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(/empty code/i);
    });

    it("throws on code exceeding max length", async () => {
      const ctx: CodeSandboxContext = {
        code: "return 1; " + "x".repeat(100_001),
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(/maximum length/i);
    });

    it("throws on runtime errors in user code", async () => {
      const ctx: CodeSandboxContext = {
        code: "return undefinedVar.foo;",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(
        /execution failed/i
      );
    });

    it("throws on syntax errors", async () => {
      const ctx: CodeSandboxContext = {
        code: "return {;",
        input: {},
      };
      await expect(evaluator.evaluate(ctx)).rejects.toThrow(GraphExecutionError);
    });

    it("throws on infinite loop (timeout)", async () => {
      const slowEvaluator = new IsolatedVmCodeSandboxEvaluator(100, 8);
      const ctx: CodeSandboxContext = {
        code: "while (true) { }",
        input: {},
      };
      await expect(slowEvaluator.evaluate(ctx)).rejects.toThrow(/timed out/i);
    }, 10_000);
  });

  describe("JSON-serializable output", () => {
    it("returns plain objects", async () => {
      const ctx: CodeSandboxContext = {
        code: "return { a: 1, b: [1, 2], c: { nested: true } };",
        input: {},
      };
      const result = await evaluator.evaluate(ctx);
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        a: 1,
        b: [1, 2],
        c: { nested: true },
      });
    });

    it("returns arrays", async () => {
      const ctx: CodeSandboxContext = {
        code: "return [1, 2, 3];",
        input: {},
      };
      expect(await evaluator.evaluate(ctx)).toEqual([1, 2, 3]);
    });

    it("returns strings", async () => {
      const ctx: CodeSandboxContext = {
        code: "return 'hello';",
        input: {},
      };
      expect(await evaluator.evaluate(ctx)).toBe("hello");
    });
  });

  describe("host log callback isolation (SAA-1950 F2)", () => {
    it("does not expose the host dispatch reference on the sandbox global", async () => {
      const logger = createSpyLogger();
      const ctx: CodeSandboxContext = {
        // `[].constructor.constructor` reaches the Function constructor without
        // naming the blocked `Function`/`globalThis` identifiers, so this probe
        // reaches the isolate's real global object.
        code:
          "var g = [].constructor.constructor('return this')();" +
          "return typeof g['__dispatch'];",
        input: {},
        logger,
      };

      expect(await evaluator.evaluate(ctx)).toBe("undefined");
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.trace).not.toHaveBeenCalled();
    });

    it("cannot forge a host log call through the global object", async () => {
      const logger = createSpyLogger();
      const ctx: CodeSandboxContext = {
        // Old F2 vulnerability: `jail.set("__dispatch", ...)` made the host
        // reference reachable as `globalThis.__dispatch`, so user code could
        // invoke the host logger directly (and forge arbitrary log levels).
        code:
          "var g = [].constructor.constructor('return this')();" +
          "if (g['__dispatch']) { g['__dispatch'].applySync(undefined, ['error', '[\"forged\"]']); }" +
          "return g['__dispatch'] === undefined ? 'no-dispatch' : 'leaked';",
        input: {},
        logger,
      };

      expect(await evaluator.evaluate(ctx)).toBe("no-dispatch");
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("still forwards console.* calls to the provided logger", async () => {
      const logger = createSpyLogger();
      const ctx: CodeSandboxContext = {
        code: "console.log('hello from sandbox'); console.warn('careful'); return 1;",
        input: {},
        logger,
      };

      expect(await evaluator.evaluate(ctx)).toBe(1);
      expect(logger.info).toHaveBeenCalledWith("hello from sandbox", "hello from sandbox");
      expect(logger.warn).toHaveBeenCalledWith("careful", "careful");
    });
  });
});
