/**
 * @module as-graph/tests/evals/core-agent-memory
 * @summary SAA-836 E1 eval for the `core.agent.memory` agent kind (M2 memory family): a
 * mastra dataset/experiment runs the kind's single-node document through the
 * real `MastraGraphExecutionBackend` and records the experiment + per-item
 * results the step produces when it resolves its configuration into the
 * JSON-safe `mastra.memory` resource descriptor (R9 config-only fallback; the
 * live mastra `Memory` is resolved where it is consumed and never persisted).
 * @description Real: the production backend, compiler, and default handler set
 * (real `@mastra/core` `createStep`), and a real mastra dataset + experiment
 * persisted in mastra storage. Deterministic (no model provider — R1): the
 * step resolves configuration, it does not call a model.
 */
import {
  defineResourceDescriptorEval,
  memoryDescriptorScorer,
} from "./helpers";

defineResourceDescriptorEval("core.agent.memory", "core-agent-memory", {
  config: {"provider": "memory"},
  scorers: [memoryDescriptorScorer("memory")],
});
