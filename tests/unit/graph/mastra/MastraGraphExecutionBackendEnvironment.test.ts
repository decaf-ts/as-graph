/**
 * @module as-graph/tests/unit/graph/mastra/MastraGraphExecutionBackendEnvironment
 * @summary Driver tests for the mastra backend boot from Environment config
 * (SAA-836 S1, SAA-877).
 * @description Proves the engine boots from the accumulated mastra
 * environment: with no `terminalTimeoutMs` in the backend config the default
 * comes from `MastraEnvironment.mastra.engine.terminalTimeoutMs`
 * (`MASTRA__ENGINE__TERMINAL_TIMEOUT_MS`), an explicit config value wins, and
 * `MASTRA__ENGINE__ENABLED=false` fails closed initialization with
 * `GRAPH_MASTRA_ENGINE_DISABLED`.
 */
import { describe, expect, it, afterEach } from "@jest/globals";
import {
  GRAPH_MASTRA_ENGINE_DISABLED,
} from "../../../../src/mastra/MastraEnvironment";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

/** The `MASTRA__*` override variables touched by these tests. */
const OVERRIDE_VARS = [
  "MASTRA__ENGINE__ENABLED",
  "MASTRA__ENGINE__TERMINAL_TIMEOUT_MS",
] as const;

afterEach(() => {
  GraphExecutionBackendRegistry.clear();
  for (const name of OVERRIDE_VARS) {
    delete process.env[name];
  }
});

describe("MastraGraphExecutionBackend environment boot (SAA-836 S1)", () => {
  it("defaults terminalTimeoutMs from the mastra environment override", async () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect((backend as unknown as { terminalTimeoutMs: number }).terminalTimeoutMs).toBe(
      12345
    );
  });

  it("keeps the environment default when the config omits terminalTimeoutMs", async () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect(
      (backend as unknown as { terminalTimeoutMs: number }).terminalTimeoutMs
    ).toBe(12345);
  });

  it("lets an explicit config terminalTimeoutMs win over the environment", async () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {}, terminalTimeoutMs: 9999 });

    expect(
      (backend as unknown as { terminalTimeoutMs: number }).terminalTimeoutMs
    ).toBe(9999);
  });

  it("ignores a non-positive config terminalTimeoutMs and uses the environment", async () => {
    process.env["MASTRA__ENGINE__TERMINAL_TIMEOUT_MS"] = "12345";

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {}, terminalTimeoutMs: 0 });

    expect(
      (backend as unknown as { terminalTimeoutMs: number }).terminalTimeoutMs
    ).toBe(12345);
  });

  it("fails closed with GRAPH_MASTRA_ENGINE_DISABLED when MASTRA__ENGINE__ENABLED=false", async () => {
    process.env["MASTRA__ENGINE__ENABLED"] = "false";

    const backend = new MastraGraphExecutionBackend();

    await expect(backend.initialize({ mastra: {} })).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_ENGINE_DISABLED,
    });
  });

  it("initializes normally when the mastra lane is enabled", async () => {
    const backend = new MastraGraphExecutionBackend();

    await expect(backend.initialize({ mastra: {} })).resolves.toBeUndefined();
  });
});
