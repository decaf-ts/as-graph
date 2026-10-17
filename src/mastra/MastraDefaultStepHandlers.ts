/**
 * @module as-graph/mastra/MastraDefaultStepHandlers
 * @summary Default Mastra step handlers for the built-in leaf node kinds
 * (SAA-807, hardened in SAA-824, agent execution wired in SAA-837 M1).
 * @description Provides the host-provided default handler set the Mastra
 * compiler needs to translate every built-in leaf node kind. Without it an
 * empty `stepHandlers` option makes every fixture run fail closed with
 * `GRAPH_MASTRA_UNSUPPORTED_KIND` ("Mastra backend has no step handler for
 * node kind"). Each handler builds a schema-agnostic Mastra step (`z.any()`
 * input and output schemas) that coerces the runtime's step input into a
 * record and forwards it, with special-cased behaviour for `value` (emits its
 * configured value), `core.flow.delay` (honours a *clamped* `timeoutMs` and the
 * step's `abortSignal`), the log kinds (route through the optional logger), the
 * fail-closed `core.utility.code` kind, and the real
 * {@link MastraAgentRuntime}-backed `core.agent` kind (which fails closed with
 * `GRAPH_MASTRA_AGENT_UNAVAILABLE` when no runtime is configured rather than
 * forwarding a fabricated echo).
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraNodeStepHandler,
} from "./types";
import type { MastraAgentRuntime } from "./MastraAgentStepHandler";
import {
  mastraMemoryConfigOf,
  mastraMemoryDescriptorOf,
  type MastraMemoryConfig,
} from "./MastraMemory";

/**
 * The built-in leaf node kinds covered by the default handler set: the
 * plain-data, flow-utility, trigger, and utility kinds that compile as opaque
 * steps. Structural kinds (`core.flow.if`/`core.flow.switch`, the
 * `core.loop.*` loops, and `core.flow.humanApproval`) are translated by the
 * compiler itself and are deliberately absent.
 */
export const MASTRA_DEFAULT_STEP_HANDLER_KINDS = [
  "value",
  "result",
  "core.agent",
  "core.flow.break",
  "core.flow.delay",
  "core.flow.errorBoundary",
  "core.flow.log",
  "core.trigger.chat",
  "core.trigger.event",
  "core.trigger.form",
  "core.trigger.manual",
  "core.trigger.schedule",
  "core.trigger.webhook",
  "core.utility.code",
  "core.utility.log",
  "core.utility.map",
  "core.agent.tool",
  "core.agent.toolSelector",
  "core.agent.hook",
  "core.agent.toolDeny",
  "core.agent.delegationHook",
  "core.agent.skill",
  "core.agent.skillSelector",
  "core.agent.sandbox",
  "core.agent.scorer",
  "core.agent.scorerSelector",
  "core.agent.memory",
  "core.agent.memorySelector",
  "core.agent.embedding",
  "core.agent.vectorStore",
  "core.agent.retriever",
  "core.agent.chunking",
  "core.agent.rerank",
  "core.agent.chain.qa",
  "core.agent.chain.basic",
  "core.agent.chain.summarization",
  "core.agent.structuredOutputParser",
  "core.agent.informationExtractor",
  "core.agent.langchainCode",
  "core.agent.inputProcessor",
  "core.agent.outputProcessor",
  "core.agent.guardrail",
] as const;

/**
 * The mastra AI-family leaf kinds covered by the default handler set (SAA-836
 * M3). Each runs as a real mastra step that resolves the node's configuration
 * into a resource descriptor on its output port, keeping the node isolatable in
 * OUR observability layer while mastra tracks the step.
 */
export const MASTRA_AGENT_FAMILY_STEP_KINDS = [
  "core.agent.tool",
  "core.agent.toolSelector",
  "core.agent.hook",
  "core.agent.toolDeny",
  "core.agent.delegationHook",
  "core.agent.skill",
  "core.agent.skillSelector",
  "core.agent.sandbox",
  "core.agent.scorer",
  "core.agent.scorerSelector",
] as const;

/**
 * The mastra memory leaf kinds covered by the default handler set (SAA-836
 * M2): the memory provider node and its dynamic selector. Each runs as a real
 * mastra step that resolves the node's configuration into the JSON-safe memory
 * resource descriptor on its output port (R9 — the config-only fallback; the
 * live mastra `Memory` is resolved where it is consumed, by the agent runtime,
 * and is never persisted), keeping the node isolatable in OUR observability
 * layer while mastra tracks the step.
 */
export const MASTRA_MEMORY_STEP_KINDS = [
  "core.agent.memory",
  "core.agent.memorySelector",
] as const;

/**
 * The mastra RAG leaf kinds covered by the default handler set (SAA-836 M4):
 * the embedding node, vector stores, retriever, chunking/rerank nodes, the
 * chains, structured-output parser, information extractor, and the LangChain
 * Code glue kind. Each runs as a real mastra step that resolves the node's
 * configuration onto its resource output, keeping the node isolatable in OUR
 * observability layer while mastra tracks the step.
 */
export const MASTRA_RAG_STEP_KINDS = [
  "core.agent.embedding",
  "core.agent.vectorStore",
  "core.agent.retriever",
  "core.agent.chunking",
  "core.agent.rerank",
  "core.agent.chain.qa",
  "core.agent.chain.basic",
  "core.agent.chain.summarization",
  "core.agent.structuredOutputParser",
  "core.agent.informationExtractor",
  "core.agent.langchainCode",
] as const;

/**
 * The mastra processor leaf kinds covered by the default handler set (SAA-836
 * M5): the input (preprocessor) and output (post-processor) processor nodes
 * and the guardrail kind. Each runs as a real mastra step that resolves the
 * node's configuration into a resource descriptor on its output port; the
 * agent step handler resolves the same nodes' *parameters* into the live
 * `@mastra/core/processors` instances applied to agent execution (R3/R9).
 * The HITL (`core.agent.hitl`) and MCP trigger (`core.agent.trigger.mcp`)
 * kinds are deliberately absent — they carry suspend/resume and MCP-serving
 * semantics and are translated by their dedicated handlers.
 */
export const MASTRA_PROCESSOR_STEP_KINDS = [
  "core.agent.inputProcessor",
  "core.agent.outputProcessor",
  "core.agent.guardrail",
] as const;

/** Any built-in leaf node kind covered by {@link MASTRA_DEFAULT_STEP_HANDLER_KINDS}. */
export type MastraDefaultStepHandlerKind =
  (typeof MASTRA_DEFAULT_STEP_HANDLER_KINDS)[number];

/**
 * Largest delay `setTimeout` accepts before Node overflows and collapses the
 * wait to ~1ms (`2^31 - 1`). {@link createMastraDefaultStepHandlers} clamps a
 * delay node's `timeoutMs` to this value *before* scheduling, so a hostile or
 * oversized declared delay can never hit the overflow degenerate path.
 */
export const MASTRA_MAX_SET_TIMEOUT_MS = 2_147_483_647;

/**
 * Default host-configurable ceiling, in milliseconds, for a `core.flow.delay`
 * node's `timeoutMs` (60s). The declared value is clamped to this ceiling, never
 * rejected, so an oversized document cannot pin a run slot for up to
 * `MASTRA_MAX_SET_TIMEOUT_MS` (~24.8 days) per node.
 */
export const DEFAULT_MASTRA_DELAY_MAX_MS = 60_000;

/**
 * Reserved key under which the pre-SAA-837 `core.agent` default handler recorded
 * that the node was not executed. Retained for backward compatibility with
 * consumers that import it; the SAA-837 M1 handler no longer emits it — an
 * unconfigured `core.agent` step now fails closed with
 * `GRAPH_MASTRA_AGENT_UNAVAILABLE` instead of returning a fabricated echo.
 */
export const MASTRA_DEGRADED_OUTPUT_KEY = "__mastraDegraded";

/** @deprecated The SAA-837 M1 handler no longer emits degraded output. */
export interface MastraDegradedOutput {
  /** The node kind whose declared capability was not executed. */
  kind: string;
  /** The node id the degraded result belongs to. */
  nodeId: string;
  /** Human-readable reason the node degraded to a pass-through. */
  reason: string;
}

/** Options {@link createMastraDefaultStepHandlers} is created with. */
export interface MastraDefaultStepHandlerOptions {
  /**
   * Optional sink for the log kinds' messages (the default is silent).
   *
   * The sink receives **untrusted** data: `message` is the document's
   * `node.parameters.message` verbatim and `meta` carries in-flight node data. A
   * logger implementation must treat both arguments as untrusted, JSON-serialize
   * `meta`, and never interpolate either into a line-oriented log (the pattern
   * `nest/graph/servingErrors.ts` already mandates) — otherwise a crafted
   * document enables log forging or CRLF injection.
   */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Host-configurable ceiling, in milliseconds, for a `core.flow.delay` node's
   * `timeoutMs`. The declared value is clamped to this ceiling (never rejected)
   * and additionally bounded by {@link MASTRA_MAX_SET_TIMEOUT_MS}; defaults to
   * {@link DEFAULT_MASTRA_DELAY_MAX_MS}.
   */
  maxDelayMs?: number;
  /**
   * Runtime that performs real `core.agent` execution (SAA-837 M1). When
   * omitted, the `core.agent` step fails closed with
   * {@link GRAPH_MASTRA_AGENT_UNAVAILABLE} instead of forwarding a fabricated
   * echo result, so no host can silently run an agent node without an agent.
   */
  agentRuntime?: MastraAgentRuntime;
}

/** Structural subset of the Mastra runtime arguments a built-in step receives. */
type StepExecuteArgs = { inputData?: unknown; abortSignal?: AbortSignal };

/** The executor contract each default kind's behaviour is implemented with. */
type StepExecutor = (
  inputData: Record<string, unknown>,
  node: GraphNodeInstance,
  signal?: AbortSignal
) => unknown | Promise<unknown>;

/**
 * Normalises a step runtime value into a plain record.
 *
 * @param value - The value to normalise.
 * @returns The value itself when it is a non-array object, else `{}`.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Clamps a declared `core.flow.delay` `timeoutMs` to the effective ceiling.
 *
 * A non-number, non-finite, or non-positive value yields `0` (no wait). A
 * positive value is reduced to the smaller of the configured `maxDelayMs`
 * (falling back to {@link DEFAULT_MASTRA_DELAY_MAX_MS}) and
 * {@link MASTRA_MAX_SET_TIMEOUT_MS}, so the cap is always enforced before
 * `setTimeout` is called and Node's overflow degenerate path is unreachable.
 *
 * @param requested - The untrusted `timeoutMs` value from the document.
 * @param maxDelayMs - The host-configured ceiling, when provided.
 * @returns The clamped, non-negative delay in milliseconds.
 */
function clampDelayMs(requested: unknown, maxDelayMs?: number): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return 0;
  }
  const configured =
    typeof maxDelayMs === "number" && Number.isFinite(maxDelayMs) && maxDelayMs > 0
      ? maxDelayMs
      : DEFAULT_MASTRA_DELAY_MAX_MS;
  const ceiling = Math.min(configured, MASTRA_MAX_SET_TIMEOUT_MS);
  return Math.min(requested, ceiling);
}

/**
 * Sleeps for the given clamped delay, ending early when the step receives an
 * abort signal (run cancellation) so a cancelled run never leaves a detached
 * timer pinning the event loop. Forwarding is unchanged either way.
 *
 * @param delayMs - The already-clamped delay in milliseconds.
 * @param signal - The step's Mastra `abortSignal`, when the runtime supplies one.
 * @returns Resolves once the delay elapses or the signal aborts.
 */
function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (delayMs <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves the source output port that feeds a memory node's
 * `workingMemoryTemplate` input port, when a data edge wires one.
 *
 * Mastra steps receive the previous step's output values keyed by the *source*
 * output handles, so the wired template value must be read by the edge's
 * source port name, resolved from the document at translation time.
 *
 * @param node - The memory node being translated.
 * @param document - The canonical document being compiled, when available.
 * @returns The source port name of the wiring edge, or `undefined` when the
 *   input is not wired.
 */
function wiredTemplateSourcePortOf(
  node: GraphNodeInstance,
  document?: GraphWorkflowDocument
): string | undefined {
  for (const edge of document?.edges ?? []) {
    if (edge.type !== "data") continue;
    const { source, target } = edge;
    if (
      target.scope === "node" &&
      target.nodeId === node.id &&
      target.port === "workingMemoryTemplate" &&
      source.scope === "node"
    ) {
      return source.port;
    }
  }
  return undefined;
}

/**
 * Resolves the executor implementing one default kind's behaviour. Every kind
 * forwards its (record-coerced) step input; `value` instead emits its
 * configured `value` parameter, `core.flow.delay` waits a clamped `timeoutMs`
 * (bounded by the options ceiling and Node's `setTimeout` maximum) before
 * forwarding, `core.agent` delegates to the configured
 * {@link MastraAgentRuntime} (failing closed when none is configured), the log
 * kinds emit the node's `message` parameter (falling back to its kind) through
 * the options logger, and `core.utility.code` fails closed with
 * {@link GRAPH_MASTRA_UNSUPPORTED_KIND}.
 *
 * @param kind - The default handler kind to build an executor for.
 * @param options - Handler-set options providing the optional logger, delay
 *   ceiling, and agent runtime.
 * @param wiredTemplateSource - For `core.agent.memory`, the source output port
 *   feeding the node's wired `workingMemoryTemplate` input (see
 *   {@link wiredTemplateSourcePortOf}).
 * @returns The executor the kind's Mastra steps delegate to.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when a
 *   code-mode node reaches the `core.utility.code` executor;
 *   {@link GRAPH_MASTRA_AGENT_UNAVAILABLE} when a `core.agent` node reaches the
 *   agent executor with no runtime configured.
 */
function executorFor(
  kind: MastraDefaultStepHandlerKind,
  options: MastraDefaultStepHandlerOptions,
  wiredTemplateSource?: string
): StepExecutor {
  switch (kind) {
    case "value":
      return (_inputData, node) => ({
        value: asRecord(node.parameters)["value"] ?? null,
      });
    case "core.agent":
      return async (inputData, node, signal) => {
        const runtime = options.agentRuntime;
        if (!runtime) {
          throw new GraphExecutionError(
            `core.agent node '${node.id}' has no mastra agent runtime configured`,
            GRAPH_MASTRA_AGENT_UNAVAILABLE,
            { nodeId: node.id, kind: node.kind }
          );
        }
        return runtime.execute(node, inputData, signal);
      };
    case "core.utility.code":
      return (_inputData, node) => {
        throw new GraphExecutionError(
          `Mastra default step handlers do not execute code-mode node kind '${node.kind}'`,
          GRAPH_MASTRA_UNSUPPORTED_KIND,
          { nodeId: node.id, kind: node.kind }
        );
      };
    case "core.flow.delay":
      return async (inputData, node, signal) => {
        const delayMs = clampDelayMs(
          asRecord(node.parameters)["timeoutMs"],
          options.maxDelayMs
        );
        await abortableDelay(delayMs, signal);
        return inputData;
      };
    case "core.flow.log":
    case "core.utility.log":
      return (inputData, node) => {
        const message = asRecord(node.parameters)["message"];
        options.logger?.(
          typeof message === "string" ? message : node.kind,
          { nodeId: node.id, value: inputData["value"] }
        );
        return inputData;
      };
    case "core.agent.tool":
    case "core.agent.toolSelector":
    case "core.agent.hook":
    case "core.agent.toolDeny":
    case "core.agent.delegationHook":
    case "core.agent.skill":
    case "core.agent.skillSelector":
    case "core.agent.sandbox":
    case "core.agent.scorer":
    case "core.agent.scorerSelector":
    case "core.agent.embedding":
    case "core.agent.vectorStore":
    case "core.agent.retriever":
    case "core.agent.chunking":
    case "core.agent.rerank":
    case "core.agent.chain.qa":
    case "core.agent.chain.basic":
    case "core.agent.chain.summarization":
    case "core.agent.structuredOutputParser":
    case "core.agent.informationExtractor":
    case "core.agent.langchainCode":
    case "core.agent.inputProcessor":
    case "core.agent.outputProcessor":
    case "core.agent.guardrail":
      return (inputData, node) => ({
        ...inputData,
        resource: {
          kind: node.kind,
          nodeId: node.id,
          parameters: asRecord(node.parameters),
        },
      });
    case "core.agent.memory": {
      // SAA-836 M2: emit the JSON-safe, secret-free memory descriptor (R9
      // config-only fallback); the live mastra `Memory` is resolved where the
      // resource is consumed (the agent runtime) and never persisted. A wired
      // `workingMemoryTemplate` input overrides the configured template,
      // matching the node class's contract on the local engine; the wired
      // value is read by the wiring edge's source output port (Mastra steps
      // receive prior-step outputs keyed by source handles).
      return (inputData, node) => {
        const config: MastraMemoryConfig =
          mastraMemoryConfigOf(node) ?? { provider: "memory" };
        const wiredTemplate =
          (wiredTemplateSource !== undefined
            ? inputData[wiredTemplateSource]
            : undefined) ?? inputData["workingMemoryTemplate"];
        if (
          typeof wiredTemplate === "string" &&
          wiredTemplate.trim().length > 0
        ) {
          config.workingMemoryTemplate = wiredTemplate;
        }
        return {
          ...inputData,
          resource: mastraMemoryDescriptorOf(config),
        };
      };
    }
    case "core.agent.memorySelector": {
      // SAA-836 M2: the decision sub-flow shape — a string decision selects the
      // memory id, otherwise the first declared candidate; `resource` carries
      // the selected memory's JSON-safe descriptor (or null for no selection).
      return (inputData, node) => {
        const decision = inputData["decision"] ?? inputData["value"];
        const parameters = asRecord(node.parameters);
        const available = Array.isArray(parameters["memories"])
          ? (parameters["memories"] as unknown[])
          : [];
        const selected =
          typeof decision === "string"
            ? decision
            : available.length
              ? available[0]
              : undefined;
        return {
          ...inputData,
          selected: selected ?? null,
          resource: selected
            ? { type: "mastra.memory", id: selected }
            : null,
        };
      };
    }
    default:
      return (inputData) => inputData;
  }
}

/**
 * Builds the default {@link MastraNodeStepHandler} set: one handler per
 * {@link MastraDefaultStepHandlerKind}. Each handler creates a
 * schema-agnostic Mastra step (`z.any()` input and output schemas) whose
 * execution coerces the runtime's input data to a record and delegates to the
 * kind's executor, so untyped document parameters never break the runtime.
 *
 * @param options - Optional handler-set options (logger and delay ceiling).
 * @returns One {@link MastraNodeStepHandler} per entry of
 *   {@link MASTRA_DEFAULT_STEP_HANDLER_KINDS}.
 */
export function createMastraDefaultStepHandlers(
  options: MastraDefaultStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  return MASTRA_DEFAULT_STEP_HANDLER_KINDS.map((kind) => ({
    kind,
    createStep: (node, { stepId, document }) => {
      const executor =
        kind === "core.agent.memory"
          ? executorFor(
              kind,
              options,
              wiredTemplateSourcePortOf(node, document)
            )
          : executorFor(kind, options);
      return createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: StepExecuteArgs) => {
          const inputData = asRecord(args.inputData);
          return asRecord(await executor(inputData, node, args.abortSignal));
        },
      });
    },
  }));
}
