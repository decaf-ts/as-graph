/**
 * @module as-graph/nodes/devops/execute-command
 * @summary Execute Command DevOps node declaration (Stage 3a; `core.devops.executeCommand`).
 * @description Execute Command — run a shell command in a child process and
 * emit its streams. The configured `command` is required and executed through
 * `child_process.exec` with a clamped timeout (`timeoutMs`, floored to ≥1ms and
 * capped at `GRAPH_EXECUTE_COMMAND_MAX_TIMEOUT_MS`, default
 * `GRAPH_EXECUTE_COMMAND_DEFAULT_TIMEOUT_MS`), the execution context's
 * `abortSignal`, an optional `cwd` and `shell` override, and output buffered up
 * to `GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES` per stream (`stdout` and `stderr`
 * beyond that limit are truncated and the `truncated` flag set). With
 * `failOnError` a failed execution throws; otherwise the exit code and streams
 * are reported on the outputs (`result` mirrors the three stream fields).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  GRAPH_EXECUTE_COMMAND_DEFAULT_TIMEOUT_MS,
  GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES,
  GRAPH_EXECUTE_COMMAND_MAX_TIMEOUT_MS,
} from "../../../engine/constants";
import { exec } from "node:child_process";
import { asNonEmptyString, asNumber } from "../../storage/support";

/** Inputs accepted by the Execute Command node. */
export type ExecuteCommandNodeInput = Record<string, unknown>;

/** Outputs produced by the Execute Command node. */
export interface ExecuteCommandNodeOutput {
  result: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

/** Raw child-process outcome before error-policy evaluation. */
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
  truncated: boolean;
}

/** Decodes a child-process stream to a string, truncating it to the engine output cap. */
function truncate(
  value: string | Buffer | undefined,
  encoding: BufferEncoding = "utf8"
): { value: string; truncated: boolean } {
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value ?? "", encoding);
  if (buffer.length <= GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES) {
    return { value: buffer.toString(encoding), truncated: false };
  }
  return {
    value: buffer.subarray(0, GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES).toString(encoding),
    truncated: true,
  };
}

/**
 * Execute Command node (`core.devops.executeCommand`): runs a shell command
 * with bounded timeout and output buffering.
 *
 * The command string is required; every other option (`cwd`, `shell`,
 * `timeoutMs`, `failOnError`) is optional. Output is truncated to
 * `GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES` per stream.
 */
@node("core.devops.executeCommand", {
  kind: "core.devops.executeCommand",
  category: "DevOps",
  color: "#334155",
  icon: "ti-terminal-2",
  width: 96,
  height: 96,
  labels: ["devops", "shell", "command", "process"],
  metadata: {
    title: "graph.node.devops.execute_command.name",
    description: "graph.node.devops.execute_command.description",
  },
})
@model()
export class ExecuteCommandNode extends GraphNode<
  ExecuteCommandNodeInput,
  ExecuteCommandNodeOutput
> {
  /**
   * Executes the configured shell command.
   *
   * @param request - Execution request (unused directly; credentials are not consumed).
   * @param context - Graph execution context supplying the abort signal.
   * @returns Execution values with `result` (stdout/stderr/exitCode/truncated object) and the mirrored `stdout`, `stderr`, `exitCode` outputs.
   * @throws {GraphExecutionError} with code `GRAPH_EXECUTE_COMMAND_REQUIRED` when no `command` is configured, or `GRAPH_EXECUTE_COMMAND_FAILED` when the command failed and `failOnError` is set.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ExecuteCommandNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const command = asNonEmptyString(this.command);
    if (!command) {
      throw new GraphExecutionError(
        "Execute Command node requires a command",
        "GRAPH_EXECUTE_COMMAND_REQUIRED"
      );
    }
    const timeout = Math.min(
      GRAPH_EXECUTE_COMMAND_MAX_TIMEOUT_MS,
      Math.max(
        1,
        Math.floor(
          asNumber(this.timeoutMs) ??
            GRAPH_EXECUTE_COMMAND_DEFAULT_TIMEOUT_MS
        )
      )
    );
    const result = await new Promise<CommandResult>((resolve) => {
      exec(
        command,
        {
          timeout,
          maxBuffer: GRAPH_EXECUTE_COMMAND_MAX_OUTPUT_BYTES,
          cwd: asNonEmptyString(this.cwd),
          shell: asNonEmptyString(this.shell),
          signal: context.abortSignal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const out = truncate(stdout);
          const err = truncate(stderr);
          const code = (error as NodeJS.ErrnoException | null)?.code;
          resolve({
            stdout: out.value,
            stderr: err.value,
            exitCode: typeof code === "number" ? code : error ? null : 0,
            error: error ?? undefined,
            truncated: out.truncated || err.truncated,
          });
        }
      );
    });
    if (result.error && this.failOnError) {
      throw new GraphExecutionError(
        `Execute Command node command failed: ${result.error.message}`,
        "GRAPH_EXECUTE_COMMAND_FAILED",
        { exitCode: result.exitCode }
      );
    }
    return {
      result: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /** Shell command to execute (required). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.execute_command.fields.command.label",
    type: "textarea",
  })
  @input({ handle: "command", userControlled: true })
  command!: string;

  /** Working directory for the child process. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.execute_command.fields.cwd.label",
    type: "string",
  })
  @input({ handle: "cwd", userControlled: true })
  cwd?: string;

  /** Optional shell override (defaults to the platform shell). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.execute_command.fields.shell.label",
    type: "string",
  })
  @input({ handle: "shell", userControlled: true })
  shell?: string;

  /** Timeout in milliseconds; clamped to ≥1 and the engine maximum (default `GRAPH_EXECUTE_COMMAND_DEFAULT_TIMEOUT_MS`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.execute_command.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs", userControlled: true })
  timeoutMs?: number;

  /** When set, a failed command throws instead of reporting its exit code. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.execute_command.fields.failOnError.label",
    type: "boolean",
  })
  @input({ handle: "failOnError", userControlled: true })
  failOnError: boolean = false;

  /** Object carrying `stdout`, `stderr`, `exitCode`, and `truncated`. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Command standard output (truncated to the engine cap). */
  @output({ handle: "stdout" })
  stdout?: string;

  /** Command standard error (truncated to the engine cap). */
  @output({ handle: "stderr" })
  stderr?: string;

  /** Process exit code, or `null` when the process was killed by a signal. */
  @output({ handle: "exitCode", type: "number" })
  exitCode?: number | null;
}
