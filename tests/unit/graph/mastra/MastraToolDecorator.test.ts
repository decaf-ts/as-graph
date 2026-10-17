/**
 * @module as-graph/tests/unit/graph/mastra/MastraToolDecorator
 * @summary Unit tests for the SAA-836 M3 `@tool` decorator and mastra tool
 * conversion (`MastraToolDecorator`, `MastraToolConfig`).
 * @description Pins: `@tool` rejects non-method targets and empty ids; it records
 * one metadata entry per tool id; `serviceToolMethods` reads them back;
 * `mastraToolsFromService` builds real `@mastra/core` tools whose execution
 * delegates to the service method; `createMastraTool` returns a real tool; and
 * `isToolCallDenied` maps the `beforeToolCall` verdict.
 */
import { describe, it, expect } from "@jest/globals";
import { model } from "@decaf-ts/decorator-validation";
import { InternalError } from "@decaf-ts/db-decorators";
import {
  tool,
  serviceToolMethods,
  mastraToolsFromService,
  GRAPH_TOOL_METADATA_KEY,
} from "../../../../src/mastra/MastraToolDecorator";
import type { ToolMethodMetadata } from "../../../../src/mastra/MastraToolDecorator";
import {
  createMastraTool,
  isToolCallDenied,
} from "../../../../src/mastra/MastraToolConfig";

/** A service whose methods are exposed as mastra tools. */
@model()
class WeatherService {
  calls: unknown[] = [];

  /**
   * A tool backed by an async method.
   *
   * @param input - The tool input.
   * @returns A greeting string.
   */
  @tool({
    id: "getWeather",
    description: "Get the weather for a city",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  })
  async getWeather(input: { city: string }): Promise<string> {
    this.calls.push(input);
    return `sunny in ${input.city}`;
  }

  /**
   * A tool backed by a synchronous method.
   *
   * @returns The string `pong`.
   */
  @tool({ id: "ping", description: "Ping the service" })
  ping(): string {
    return "pong";
  }

  /**
   * A plain method that is not a tool.
   *
   * @returns The input.
   */
  notATool(value: string): string {
    return value;
  }
}

/** A minimal class with a single `@tool` method, used for error paths. */
class BrokenService {
  @tool({ id: "broken", description: "Broken tool" })
  broken(): string {
    return "ok";
  }
}

describe("@tool decorator (SAA-836 M3)", () => {
  it("throws InternalError when applied to a non-method target", () => {
    expect(() =>
      tool({ id: "x", description: "d" })(
        {},
        "field",
        undefined as never
      )
    ).toThrow(InternalError);
  });

  it("throws InternalError when the tool id is empty", () => {
    const descriptor = { value: () => "x" } as PropertyDescriptor;
    expect(() =>
      tool({ id: "", description: "d" })({}, "method", descriptor)
    ).toThrow(/requires a non-empty tool id/);
  });

  it("records one metadata entry per decorated method keyed by tool id", () => {
    const methods = serviceToolMethods(WeatherService);
    expect(methods.map((entry) => entry.id).sort()).toEqual([
      "getWeather",
      "ping",
    ]);
    const weather = methods.find((entry) => entry.id === "getWeather");
    expect(weather).toMatchObject<ToolMethodMetadata>({
      id: "getWeather",
      description: "Get the weather for a city",
      propertyKey: "getWeather",
    });
    expect(weather?.inputSchema).toBeDefined();
  });

  it("records the metadata under the graph.tool key", () => {
    expect(GRAPH_TOOL_METADATA_KEY).toBe("graph.tool");
    const methods = serviceToolMethods(BrokenService);
    expect(methods).toHaveLength(1);
    expect(methods[0].propertyKey).toBe("broken");
  });

  it("returns an empty list for a class with no tools", () => {
    class Plain {
      method(): string {
        return "x";
      }
    }
    expect(serviceToolMethods(Plain)).toEqual([]);
  });
});

describe("mastraToolsFromService (SAA-836 M3)", () => {
  it("builds a real mastra tool per @tool method, keyed by id", () => {
    const tools = mastraToolsFromService(new WeatherService());
    expect(Object.keys(tools).sort()).toEqual(["getWeather", "ping"]);
    for (const id of ["getWeather", "ping"]) {
      const built = tools[id] as { id?: string; execute?: unknown };
      expect(built.id).toBe(id);
      expect(typeof built.execute).toBe("function");
    }
  });

  it("delegates execution to the service method with the supplied input", async () => {
    const service = new WeatherService();
    const tools = mastraToolsFromService(service);
    const weather = tools.getWeather as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(weather.execute({ city: "Lisbon" })).resolves.toBe(
      "sunny in Lisbon"
    );
    expect(service.calls).toEqual([{ city: "Lisbon" }]);
  });

  it("awaits a synchronous service method result", async () => {
    const tools = mastraToolsFromService(new WeatherService());
    const ping = tools.ping as { execute: () => Promise<unknown> };
    await expect(ping.execute()).resolves.toBe("pong");
  });

  it("throws InternalError when a recorded method is missing at runtime", () => {
    const service = new BrokenService() as BrokenService & {
      broken: unknown;
    };
    service.broken = undefined;
    expect(() => mastraToolsFromService(service)).toThrow(/references missing method/);
  });
});

describe("MastraToolConfig conversion (SAA-836 M3)", () => {
  it("createMastraTool returns a real tool carrying the id and executor", () => {
    const built = createMastraTool({
      id: "echo",
      description: "Echo the input",
      execute: (input) => input,
    }) as { id?: string; execute?: unknown };
    expect(built.id).toBe("echo");
    expect(typeof built.execute).toBe("function");
  });

  it("createMastraTool resolves a definition without an executor", () => {
    const built = createMastraTool({
      id: "declared-only",
      description: "No executor",
    }) as { id?: string };
    expect(built.id).toBe("declared-only");
  });

  it("isToolCallDenied maps the beforeToolCall verdict", () => {
    expect(isToolCallDenied(undefined)).toBe(false);
    expect(isToolCallDenied({ proceed: true, output: "x" })).toBe(false);
    expect(isToolCallDenied({ proceed: false })).toBe(true);
    expect(isToolCallDenied({ proceed: false, output: "denied" })).toBe(true);
  });
});
