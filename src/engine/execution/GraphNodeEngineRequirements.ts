/**
 * @module as-graph/engine/execution/GraphNodeEngineRequirements
 * @summary Which node kinds require a specific execution engine (SAA-837 M1).
 * @description Single authority for the kind-level capability boundary the
 * acceptance criteria describe: the mastra AI family (`core.agent` and its
 * `core.agent.*` sub-kinds — tools, hooks, skills, sandbox, scorers) only runs on
 * the mastra backend. The general (local) engine consults this to fail closed
 * instead of executing a registered placeholder for an AI kind it cannot run.
 * Kept engine-private; node manifests keep declaring their own traits.
 */

/**
 * Kind prefix of the mastra AI family. `core.agent` itself (the agent node) and
 * every `core.agent.*` family kind require the mastra engine.
 */
export const GRAPH_MASTRA_ONLY_KIND_PREFIX = "core.agent";

/**
 * Whether a node kind requires the mastra engine. The agent node (`core.agent`)
 * and its family kinds (`core.agent.tool`, `core.agent.scorer`, …) return
 * `true`; every general-engine structural/utility/flow kind returns `false`.
 *
 * @param kind - The node kind discriminator.
 * @returns `true` when only the mastra engine can execute the kind.
 */
export function graphNodeRequiresMastraEngine(kind: string): boolean {
  return (
    kind === GRAPH_MASTRA_ONLY_KIND_PREFIX ||
    kind.startsWith(`${GRAPH_MASTRA_ONLY_KIND_PREFIX}.`)
  );
}

/**
 * Whether a node kind is a workflow entry (trigger) node.
 *
 * Read from the compiled manifest's `capabilities`, never from the kind name:
 * a trigger declares the capability through its `@node` metadata (category
 * `Trigger`, or an explicit `capabilities: ["trigger"]`). An entry node has no
 * upstream producer, so the engine hands it the run payload as its inputs.
 *
 * @param manifest - The node's resolved manifest (only `capabilities` is read).
 * @returns `true` when the kind declares the `trigger` capability.
 */
export function graphNodeIsTrigger(
  manifest: { capabilities?: readonly string[] } | undefined
): boolean {
  return manifest?.capabilities?.includes("trigger") === true;
}

/**
 * Whether a node kind only forwards the values it receives.
 *
 * Loop and branching nodes route their input to a nested run or to one of
 * their output ports without reading it, so the engine leaves binary
 * references un-hydrated for them instead of copying bytes they never touch.
 *
 * @param manifest - The node's resolved manifest (only `capabilities` is read).
 * @returns `true` when the kind declares the `loop` or `branching` capability.
 */
export function graphNodeForwardsValues(
  manifest: { capabilities?: readonly string[] } | undefined
): boolean {
  const capabilities = manifest?.capabilities ?? [];
  return capabilities.includes("loop") || capabilities.includes("branching");
}
