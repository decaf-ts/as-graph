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
