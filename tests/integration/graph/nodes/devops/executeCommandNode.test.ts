/**
 * @module as-graph/tests/integration/graph/nodes/devops/executeCommandNode
 * @summary SAA-1032: integration coverage for `core.devops.executeCommand`
 * against the real `node:child_process` runtime.
 * @description Executes real shell commands, asserting stdout/stderr capture,
 * the exit-code contract, `cwd`, the `failOnError` gate, and the documented
 * `GraphExecutionError` failure codes.
 */
import { describe, it, expect } from "@jest/globals";
import { ExecuteCommandNode } from "../../../../../src/node/devops/execute-command/node";
import { runNode } from "../real-service-support";

jest.setTimeout(60000);

const kind = "core.devops.executeCommand";

describe("core.devops.executeCommand (real child_process)", () => {
  it("captures stdout and reports a zero exit code", async () => {
    const result = await runNode(ExecuteCommandNode, kind, {
      command: "printf 'hello-command'",
    });
    expect(result.stdout).toBe("hello-command");
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      stdout: "hello-command",
      exitCode: 0,
      truncated: false,
    });
  });

  it("captures stderr", async () => {
    const result = await runNode(ExecuteCommandNode, kind, {
      command: "printf 'stderr-line' >&2",
    });
    expect(result.stderr).toBe("stderr-line");
    expect(result.exitCode).toBe(0);
  });

  it("returns a non-zero exit code without throwing when failOnError is false", async () => {
    const result = await runNode(ExecuteCommandNode, kind, {
      command: "exit 3",
    });
    expect(result.exitCode).toBe(3);
    expect(result.result).toMatchObject({ exitCode: 3 });
  });

  it("throws GRAPH_EXECUTE_COMMAND_FAILED when failOnError is true", async () => {
    await expect(
      runNode(ExecuteCommandNode, kind, {
        command: "exit 4",
        failOnError: true,
      })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_EXECUTE_COMMAND_FAILED",
      details: { exitCode: 4 },
    });
  });

  it("honours the configured cwd", async () => {
    const result = await runNode(ExecuteCommandNode, kind, {
      command: "pwd",
      cwd: "/tmp",
    });
    expect(String(result.stdout).trim()).toBe("/tmp");
  });

  it("kills a command that exceeds timeoutMs", async () => {
    const result = await runNode(ExecuteCommandNode, kind, {
      command: "sleep 5",
      timeoutMs: 100,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("requires a command", async () => {
    await expect(
      runNode(ExecuteCommandNode, kind, { command: "   " })
    ).rejects.toMatchObject({ graphCode: "GRAPH_EXECUTE_COMMAND_REQUIRED" });
  });
});
