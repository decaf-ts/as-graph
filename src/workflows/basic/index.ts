/**
 * @module as-graph/workflows/basic
 * @summary Engine-neutral demo workflow fixture registry (SAA-2049,
 * SAA-1545 §5.1).
 * @description The basic fixture set contains only engine-neutral node kinds.
 * It is the registry the local/general engine seeds at boot; Mastra capability
 * fixtures live under `../mastra` and are never merged into this array.
 */
import { manualLogFixture } from "./manual-log.workflow";
import { eventMapFixture } from "./event-map.workflow";
import { webhookFormFixture } from "./webhook-form.workflow";
import { scheduleCodeFixture } from "./schedule-code.workflow";
import { ifSwitchFixture } from "./if-switch.workflow";
import { foreachBreakFixture } from "./foreach-break.workflow";
import { humanApprovalFixture } from "./human-approval.workflow";
import { errorBoundaryFixture } from "./error-boundary.workflow";
import { loopsWhileUntilFixture } from "./loops-while-until.workflow";
import { valueTemplatesFixture } from "./value-templates.workflow";
import { boundaryValueFixture } from "./boundary-value.workflow";
import {
  ALL_CONFIG_COMBOS,
  buildFixtureMatrix,
  normalizeFixture,
  uncoveredKinds,
} from "../coverage";
import type { GraphConfigCombo, GraphWorkflowFixture } from "../types";

export * from "./manual-log.workflow";
export * from "./event-map.workflow";
export * from "./webhook-form.workflow";
export * from "./schedule-code.workflow";
export * from "./if-switch.workflow";
export * from "./foreach-break.workflow";
export * from "./human-approval.workflow";
export * from "./error-boundary.workflow";
export * from "./loops-while-until.workflow";
export * from "./value-templates.workflow";
export * from "./boundary-value.workflow";

/** Every engine-neutral built-in node kind the basic fixture registry covers. */
export const ALL_BASIC_NODE_KINDS = [
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

/** Every config-combination the basic registry must cover. */
export { ALL_CONFIG_COMBOS };
export type { GraphConfigCombo };

/** The engine-neutral demo workflow fixtures. */
export const basicWorkflowFixtures: GraphWorkflowFixture[] = [
  manualLogFixture,
  eventMapFixture,
  webhookFormFixture,
  scheduleCodeFixture,
  ifSwitchFixture,
  foreachBreakFixture,
  humanApprovalFixture,
  errorBoundaryFixture,
  loopsWhileUntilFixture,
  valueTemplatesFixture,
  boundaryValueFixture,
].map((fixture) => normalizeFixture(fixture, "basic", "local"));

/** The basic fixtures keyed by id. */
export const basicWorkflowFixturesById: Record<string, GraphWorkflowFixture> =
  Object.fromEntries(
    basicWorkflowFixtures.map((fixture) => [fixture.id, fixture])
  );

/** Basic fixtures the local engine executes end to end. */
export const executableBasicWorkflowFixtures = basicWorkflowFixtures.filter(
  (fixture) => fixture.executable
);

/** Basic fixtures blocked by a production gap. */
export const nonExecutableBasicWorkflowFixtures = basicWorkflowFixtures.filter(
  (fixture) => !fixture.executable
);

/** Node → workflow → combo matrix for the basic registry. */
export function buildBasicFixtureMatrix(): Record<
  string,
  { workflows: string[]; combos: GraphConfigCombo[] }
> {
  return buildFixtureMatrix(basicWorkflowFixtures, ALL_BASIC_NODE_KINDS);
}

/** Basic node kinds with no fixture coverage. */
export function uncoveredBasicKinds(): string[] {
  return uncoveredKinds(basicWorkflowFixtures, ALL_BASIC_NODE_KINDS);
}
