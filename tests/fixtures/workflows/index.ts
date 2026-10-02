/**
 * @module as-graph/tests/fixtures/workflows
 * @summary Persisted demo workflow fixture registry (SAA-2049 / SAA-2015 W4b).
 * @description Exports every demo `GraphWorkflowDocument`, a registry keyed by
 * fixture id, the node→workflow→combo matrix, and the complete list of built-in
 * node kinds the registry is expected to cover.
 */
import { manualLogFixture } from "./manual-log.workflow";
import { eventMapFixture } from "./event-map.workflow";
import { chatAgentFixture } from "./chat-agent.workflow";
import { webhookFormFixture } from "./webhook-form.workflow";
import { scheduleCodeFixture } from "./schedule-code.workflow";
import { ifSwitchFixture } from "./if-switch.workflow";
import { foreachBreakFixture } from "./foreach-break.workflow";
import { humanApprovalFixture } from "./human-approval.workflow";
import { errorBoundaryFixture } from "./error-boundary.workflow";
import { loopsWhileUntilFixture } from "./loops-while-until.workflow";
import { valueTemplatesFixture } from "./value-templates.workflow";
import { boundaryValueFixture } from "./boundary-value.workflow";
import type { GraphConfigCombo, GraphWorkflowFixture } from "./types";

export * from "./types";
export * from "./manual-log.workflow";
export * from "./event-map.workflow";
export * from "./chat-agent.workflow";
export * from "./webhook-form.workflow";
export * from "./schedule-code.workflow";
export * from "./if-switch.workflow";
export * from "./foreach-break.workflow";
export * from "./human-approval.workflow";
export * from "./error-boundary.workflow";
export * from "./loops-while-until.workflow";
export * from "./value-templates.workflow";
export * from "./boundary-value.workflow";

/**
 * Every one of the 22 built-in node kinds the fixture registry must cover.
 */
export const ALL_BUILT_IN_NODE_KINDS = [
  "core.agent",
  "value",
  "result",
  "core.flow.break",
  "core.flow.errorBoundary",
  "core.flow.humanApproval",
  "core.flow.if",
  "core.loop.foreach",
  "core.loop.until",
  "core.loop.while",
  "core.flow.switch",
  "core.trigger.chat",
  "core.trigger.event",
  "core.trigger.form",
  "core.trigger.manual",
  "core.trigger.schedule",
  "core.trigger.webhook",
  "core.utility.code",
  "core.flow.delay",
  "core.flow.log",
  "core.utility.map",
  "core.utility.log",
] as const;

/**
 * Every config-combination the fixture registry must cover.
 */
export const ALL_CONFIG_COMBOS: GraphConfigCombo[] = [
  "straight-value",
  "code-expression",
  "text-template",
  "exposed-ports",
  "user-controlled-properties",
  "defaults",
];

/**
 * The demo workflow fixtures, keyed by id.
 */
export const graphWorkflowFixtures: GraphWorkflowFixture[] = [
  manualLogFixture,
  eventMapFixture,
  chatAgentFixture,
  webhookFormFixture,
  scheduleCodeFixture,
  ifSwitchFixture,
  foreachBreakFixture,
  humanApprovalFixture,
  errorBoundaryFixture,
  loopsWhileUntilFixture,
  valueTemplatesFixture,
  boundaryValueFixture,
];

/** The demo workflow fixtures keyed by id. */
export const graphWorkflowFixturesById: Record<string, GraphWorkflowFixture> =
  Object.fromEntries(
    graphWorkflowFixtures.map((fixture) => [fixture.id, fixture])
  );

/** Fixtures the real engine can execute end to end. */
export const executableWorkflowFixtures = graphWorkflowFixtures.filter(
  (fixture) => fixture.executable
);

/** Fixtures that are persisted/validated but blocked by a production gap. */
export const nonExecutableWorkflowFixtures = graphWorkflowFixtures.filter(
  (fixture) => !fixture.executable
);

/** Node→workflow→combo matrix derived from the registry. */
export function buildFixtureMatrix(): Record<
  string,
  { workflows: string[]; combos: GraphConfigCombo[] }
> {
  const matrix: Record<
    string,
    { workflows: string[]; combos: GraphConfigCombo[] }
  > = {};
  for (const kind of ALL_BUILT_IN_NODE_KINDS) {
    matrix[kind] = { workflows: [], combos: [] };
  }
  for (const fixture of graphWorkflowFixtures) {
    for (const kind of fixture.kinds) {
      if (!matrix[kind]) matrix[kind] = { workflows: [], combos: [] };
      if (!matrix[kind].workflows.includes(fixture.id)) {
        matrix[kind].workflows.push(fixture.id);
      }
      for (const combo of fixture.combos) {
        if (!matrix[kind].combos.includes(combo)) {
          matrix[kind].combos.push(combo);
        }
      }
    }
  }
  return matrix;
}
