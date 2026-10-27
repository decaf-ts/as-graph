/**
 * @module as-graph/mastra/nodes/MastraNodeRegistry
 * @summary Single source of truth for Mastra-owned node kinds (SAA-1545 §3.2).
 * @description Binds every kind in {@link MASTRA_NODE_CLASSES_BY_KIND} to its
 * node class, published manifest, and Mastra execution adapter. The backend
 * pulls its handler set from here; the coverage audit fails registration when a
 * kind has no class, no manifest, no concrete `execute()` implementation, or no
 * adapter, so a gap surfaces as a startup error rather than a fabricated step.
 */
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { graphNodeRequiresMastraEngine } from "../../engine/execution/GraphNodeEngineRequirements";
import { GraphNode } from "../../node/base";
import { createMastraAgentStepHandler } from "../MastraAgentStepHandler";
import { createMastraChannelResponseStepHandlers } from "../MastraChannelResponse";
import { createMastraChannelTriggerStepHandlers } from "../MastraChannelTrigger";
import { createMastraDefaultStepHandlers } from "../MastraDefaultStepHandlers";
import { createMastraHitlStepHandler } from "../MastraHitlStepHandler";
import { createMastraMcpTriggerStepHandler } from "../MastraMcpTrigger";
import { createMastraRagStepHandlers } from "../MastraRagStepHandlers";
import { createMastraVoiceStepHandler } from "../MastraVoiceStepHandler";
import type { MastraNodeStepHandler } from "../types";
import { MASTRA_NODE_CLASSES_BY_KIND } from "./classes";
import { MASTRA_NODE_MANIFESTS_BY_KIND } from "./manifests";
import { createMastraNodeStepHandler } from "./MastraNodeStepAdapter";
import type {
  MastraNodeCoverageGap,
  MastraNodeHandlerOptions,
  MastraNodeKindImplementation,
} from "./types";

/** A step-handler factory entry contributing the handlers of one options group. */
interface HandlerGroup {
  create: (options: MastraNodeHandlerOptions) => MastraNodeStepHandler[];
}

/**
 * Handler groups in registration order. Specific groups own the host-service
 * kinds; any Mastra kind they do not cover is reached through the generic
 * node-class adapter (pure/configuration kinds).
 */
const HANDLER_GROUPS: readonly HandlerGroup[] = [
  { create: (options) => createMastraDefaultStepHandlers(options.default) },
  { create: (options) => [createMastraAgentStepHandler(options.agent)] },
  { create: () => [createMastraHitlStepHandler()] },
  { create: (options) => [createMastraMcpTriggerStepHandler(options.mcp)] },
  {
    create: (options) =>
      createMastraChannelTriggerStepHandlers(options.channelTrigger),
  },
  {
    create: (options) =>
      createMastraChannelResponseStepHandlers(options.channelResponse),
  },
  { create: (options) => [createMastraVoiceStepHandler(options.voice)] },
  { create: (options) => createMastraRagStepHandlers(options.rag) },
];

/**
 * Builds the handler map for one options bundle: specific groups first, then a
 * generic node-class adapter for every remaining Mastra-owned kind.
 *
 * @param options - The handler options forwarded to each group.
 * @returns The complete kind→handler map for every Mastra-owned kind.
 */
function handlersFor(
  options: MastraNodeHandlerOptions
): Map<string, MastraNodeStepHandler> {
  const handlers = new Map<string, MastraNodeStepHandler>();
  for (const group of HANDLER_GROUPS) {
    for (const handler of group.create(options)) {
      if (!graphNodeRequiresMastraEngine(handler.kind)) continue;
      handlers.set(handler.kind, handler);
    }
  }
  for (const [kind, nodeClass] of Object.entries(
    MASTRA_NODE_CLASSES_BY_KIND
  )) {
    if (handlers.has(kind)) continue;
    handlers.set(kind, createMastraNodeStepHandler(kind, nodeClass, {}));
  }
  return handlers;
}

/**
 * Returns `true` when the class overrides the base `GraphNode.execute`, i.e.
 * the kind has a concrete implementation rather than inheriting the fail-fast
 * default.
 *
 * @param nodeClass - The registered node class.
 * @returns `true` when the class declares its own `execute`.
 */
function hasConcreteExecute(nodeClass: unknown): boolean {
  const prototype = (nodeClass as { prototype?: { execute?: unknown } })
    .prototype;
  if (!prototype || typeof prototype.execute !== "function") return false;
  return prototype.execute !== GraphNode.prototype.execute;
}

/**
 * Builds one implementation per Mastra-owned kind, ordered by kind.
 *
 * @returns The complete implementation list.
 */
function buildImplementations(): MastraNodeKindImplementation[] {
  return Object.keys(MASTRA_NODE_CLASSES_BY_KIND)
    .sort((left, right) => left.localeCompare(right))
    .map((kind) => ({
      kind,
      nodeClass: MASTRA_NODE_CLASSES_BY_KIND[kind],
      manifest: MASTRA_NODE_MANIFESTS_BY_KIND[kind],
      createStepHandlers: (options: MastraNodeHandlerOptions) => {
        const handler = handlersFor(options).get(kind);
        return handler ? [handler] : [];
      },
    }));
}

/** Every Mastra-owned node kind with its built-in implementation, ordered by kind. */
export const MASTRA_NODE_IMPLEMENTATIONS: readonly MastraNodeKindImplementation[] =
  buildImplementations();

/** The kinds of {@link MASTRA_NODE_IMPLEMENTATIONS}, ordered the same way. */
export const MASTRA_ONLY_NODE_KINDS: readonly string[] =
  MASTRA_NODE_IMPLEMENTATIONS.map((implementation) => implementation.kind);

/** Lookup from node kind to its Mastra implementation. */
export const MASTRA_NODE_IMPLEMENTATION_BY_KIND: ReadonlyMap<
  string,
  MastraNodeKindImplementation
> = new Map(
  MASTRA_NODE_IMPLEMENTATIONS.map((implementation) => [
    implementation.kind,
    implementation,
  ])
);

/**
 * Produces the complete set of Mastra step handlers the backend registers, one
 * per Mastra-owned kind, deduplicated by kind.
 *
 * @param options - Options forwarded to each handler group's factory.
 * @returns The deduplicated step handlers for all Mastra-owned kinds.
 */
export function createMastraNodeStepHandlers(
  options: MastraNodeHandlerOptions = {}
): MastraNodeStepHandler[] {
  assertMastraNodeCoverage();
  const handlers = handlersFor(options);
  return [...handlers.values()];
}

/**
 * Audits the given (default: every Mastra-owned) kind list for complete,
 * executable declarations.
 *
 * @param kinds - Node kinds to audit; defaults to every Mastra-owned kind.
 * @returns One gap per missing implementation/class/manifest/execute/adapter.
 */
export function auditMastraNodeCoverage(
  kinds: readonly string[] = [
    ...new Set([
      ...Object.keys(MASTRA_NODE_CLASSES_BY_KIND),
      ...Object.keys(MASTRA_NODE_MANIFESTS_BY_KIND),
    ]),
  ]
): MastraNodeCoverageGap[] {
  const gaps: MastraNodeCoverageGap[] = [];
  for (const kind of kinds) {
    if (!graphNodeRequiresMastraEngine(kind)) continue;
    const implementation = MASTRA_NODE_IMPLEMENTATION_BY_KIND.get(kind);
    if (!implementation) {
      gaps.push({ kind, reason: "missing-implementation" });
      continue;
    }
    if (!implementation.nodeClass) {
      gaps.push({ kind, reason: "missing-node-class" });
      continue;
    }
    if (!implementation.manifest) {
      gaps.push({ kind, reason: "missing-manifest" });
      continue;
    }
    if (!hasConcreteExecute(implementation.nodeClass)) {
      gaps.push({ kind, reason: "missing-execute" });
      continue;
    }
    if (implementation.createStepHandlers({}).length === 0) {
      gaps.push({ kind, reason: "missing-execution-adapter" });
    }
  }
  return gaps;
}

/**
 * Asserts complete Mastra node-kind coverage, throwing instead of returning
 * gaps.
 *
 * @param kinds - Node kinds to audit; defaults to every Mastra-owned kind.
 * @throws {GraphExecutionError} with code `GRAPH_MASTRA_NODE_KIND_UNIMPLEMENTED`
 *   listing every uncovered kind and reason.
 */
export function assertMastraNodeCoverage(kinds?: readonly string[]): void {
  const gaps = auditMastraNodeCoverage(kinds);
  if (gaps.length > 0) {
    throw new GraphExecutionError(
      `Mastra node registry does not implement: ${gaps
        .map((gap) => `${gap.kind} (${gap.reason})`)
        .join(", ")}`,
      "GRAPH_MASTRA_NODE_KIND_UNIMPLEMENTED",
      { gaps }
    );
  }
}
