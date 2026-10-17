/**
 * @module as-graph/tests/evals/core-agent-chain-qa
 * @summary SAA-836 E1 eval for the `core.agent.chain.qa` agent kind: a mastra
 * dataset/experiment runs the kind's single-node document through the real
 * `MastraGraphExecutionBackend` and records the experiment + per-item results
 * the step produces when it resolves its configuration into the JSON-safe
 * `resource` descriptor (R9 config-only fallback).
 * @description Real: the production backend, compiler, and default handler set
 * (real `@mastra/core` `createStep`), and a real mastra dataset + experiment
 * persisted in mastra storage. Deterministic (no model provider — R1): the
 * step resolves configuration, it does not call a model.
 */
import {
  defineResourceDescriptorEval,
} from "./helpers";

defineResourceDescriptorEval("core.agent.chain.qa", "core-agent-chain-qa", {
  config: {},
});
