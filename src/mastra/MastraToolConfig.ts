/**
 * @module as-graph/mastra/MastraToolConfig
 * @summary Mastra tool/hook/scorer/skill/sandbox configuration mirror (SAA-836 M3).
 * @description The AI-family node kinds declared under `src/node/agents/**` mirror
 * the real `@mastra/core` configuration objects 1:1 (real mastra-first parity, R3).
 * This module carries the config shapes plus the guarded constructors that turn a
 * document-resolved configuration into the mastra native object, using the real
 * `@mastra/core` factories (`createTool`, `createScorer`, `createSkill`,
 * `Workspace`/`LocalSandbox`). The document schema validation (credentials
 * references, ceiling guards) lives on the node kinds; this module only maps an
 * already-resolved config.
 */
import { createTool } from "@mastra/core/tools";

/** A tool definition mirroring the subset of `@mastra/core` `createTool` opts the tool node mirrors. */
export interface MastraToolDefinition {
  /** The mastra tool id. */
  id: string;
  /** The human/model-facing tool description. */
  description: string;
  /** Optional zod input schema. */
  inputSchema?: unknown;
  /** Optional zod output schema. */
  outputSchema?: unknown;
  /** Optional suspend schema. */
  suspendSchema?: unknown;
  /** Optional resume schema. */
  resumeSchema?: unknown;
  /** Whether the tool call requires human approval before executing. */
  requireApproval?: boolean;
  /** The tool executor. */
  execute?: (input: unknown, context?: unknown) => unknown | Promise<unknown>;
}

/** The result a `beforeToolCall` hook returns to (possibly) deny a call. */
export interface MastraBeforeToolCallResult {
  /** `false` denies the tool call. */
  proceed: boolean;
  /** The value returned to the model in place of the tool output when denied. */
  output?: unknown;
}

/** Context handed to a `beforeToolCall` / `afterToolCall` hook. */
export interface MastraToolHookContext {
  /** The mastra tool name being invoked. */
  toolName: string;
  /** The input the model supplied for the call. */
  input: unknown;
  /** The tool call id, when the runtime supplies one. */
  toolCallId?: string;
  /** The agent id that initiated the call, when known. */
  agentId?: string;
}

/** Context handed to an `afterToolCall` hook (adds the output or the error). */
export interface MastraToolAfterHookContext extends MastraToolHookContext {
  /** The tool output, when the call succeeded. */
  output?: unknown;
  /** The tool error, when the call failed. */
  error?: unknown;
}

/** Tool hook configuration mirroring mastra's `ToolHooks`. */
export interface MastraToolHooksConfig {
  /** Runs before a tool call; may deny it via `{ proceed: false, output }`. */
  beforeToolCall?: (
    context: MastraToolHookContext
  ) => void | MastraBeforeToolCallResult | Promise<void | MastraBeforeToolCallResult>;
  /** Runs after a tool call with the output or error. */
  afterToolCall?: (
    context: MastraToolAfterHookContext
  ) => void | Promise<void>;
}

/** Context handed to an `onDelegationStart` hook. */
export interface MastraDelegationStartContext {
  /** The delegating (parent) agent id. */
  fromAgentId: string;
  /** The target (sub) agent id. */
  toAgentId: string;
  /** The input forwarded to the sub-agent. */
  input?: unknown;
}

/** Result an `onDelegationStart` hook returns to stop or modify a delegation. */
export interface MastraDelegationStartResult {
  /** `false` denies the delegation. */
  proceed?: boolean;
  /** A replacement input for the sub-agent. */
  modifiedInput?: unknown;
}

/** Context handed to an `onDelegationComplete` hook. */
export interface MastraDelegationCompleteContext extends MastraDelegationStartContext {
  /** The sub-agent output, when the delegation succeeded. */
  output?: unknown;
  /** The delegation error, when it failed. */
  error?: unknown;
}

/** Delegation hook configuration mirroring mastra's `DelegationConfig` hook subset. */
export interface MastraDelegationHooksConfig {
  /** Runs before a sub-agent delegation; may deny or rewrite it. */
  onDelegationStart?: (
    context: MastraDelegationStartContext
  ) => void | MastraDelegationStartResult | Promise<void | MastraDelegationStartResult>;
  /** Runs after a sub-agent delegation completes. */
  onDelegationComplete?: (
    context: MastraDelegationCompleteContext
  ) => void | Promise<void>;
}

/** A scorer definition mirroring the subset of mastra `createScorer` config the scorer node mirrors. */
export interface MastraScorerDefinition {
  /** The scorer id. */
  id: string;
  /** The scorer description. */
  description: string;
  /** Optional scorer name. */
  name?: string;
  /**
   * The scorer type shortcut (`'agent'`, `'traces'`, `'response'`, …) or an
   * explicit `{ input, output }` zod pair. Passed to `createScorer` verbatim.
   */
  type?: unknown;
}

/** A skill definition mirroring the subset of mastra `createSkill` input the skill node mirrors. */
export interface MastraSkillDefinition {
  /** The skill name. */
  name: string;
  /** The skill description. */
  description?: string;
  /** The skill instructions/body. */
  instructions?: string;
}

/** Sandbox isolation mode mirroring mastra `LocalSandboxOptions['isolation']`. */
export type MastraSandboxIsolation = "none" | "seatbelt" | "bwrap";

/** A sandbox definition mirroring the subset of mastra `LocalSandboxOptions` the sandbox node mirrors. */
export interface MastraSandboxDefinition {
  /** The sandbox working directory. */
  workingDirectory?: string;
  /** The isolation mode. */
  isolation?: MastraSandboxIsolation;
  /** The sandbox command timeout, in milliseconds (ceiling-clamped by the node). */
  timeoutMs?: number;
  /** Extra environment variables for the sandbox process. */
  env?: Record<string, string>;
}

/**
 * Builds the real mastra tool from a resolved definition.
 *
 * Uses the real `@mastra/core` `createTool` factory; when the definition carries
 * no executor the tool still resolves (mastra tools may omit `execute`), matching
 * the library contract rather than inventing a fallback.
 *
 * @param definition - The resolved tool definition.
 * @returns The mastra `Tool` instance.
 */
export function createMastraTool(definition: MastraToolDefinition): unknown {
  return createTool(definition as never);
}

/**
 * Converts a `beforeToolCall` hook result into the boolean deny decision the
 * hook node sub-flow produces: a result whose `proceed` is `false` denies.
 *
 * @param result - The hook result (or `undefined` for "no verdict").
 * @returns `true` when the call is denied.
 */
export function isToolCallDenied(
  result: MastraBeforeToolCallResult | undefined
): boolean {
  return result?.proceed === false;
}
