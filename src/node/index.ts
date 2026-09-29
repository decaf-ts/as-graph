/**
 * @module as-graph/nodes
 * @summary Shared node kind declarations (DECAF-32 §22.2, DECAF-50 Phase A).
 * @description Canonical `@node`-decorated classes for the ALFRED-5 node kind
 * taxonomy, laid out one node per file under `nodes/<category>/<node>.ts`:
 * triggers (§22.2.1), flow-control and utility nodes (§22.2.2–22.2.3), the
 * Agent node (§21.3), the three loop kinds (`core.loop.foreach/while/until`,
 * §5.9), and the workflow input-value boundary node. Shared non-node support
 * (the base class and manifests) lives in sibling files under the same tree;
 * category styles remain in `@decaf-ts/ui-decorators` (`graph/category-styles`).
 * Consumers (for-angular, ALFRED, etc.) import these declarations
 * to populate node palettes, registries, and reference snapshots.
 */
export * from "./base";
export * from "./flow-control/break";
export * from "./flow-control/error-boundary";
export * from "./flow-control/human-approval";
export * from "./flow-control/if";
export * from "./flow-control/parallel";
export * from "./flow-control/switch";
export * from "./utility/code";
export * from "./utility/delay";
export * from "./utility/log";
export * from "./utility/map";
export * from "./utility/merge";
export * from "./utility/return";
export * from "./utility/utility-log";
export * from "./triggers/chat";
export * from "./triggers/event";
export * from "./triggers/form";
export * from "./triggers/manual";
export * from "./triggers/schedule";
export * from "./triggers/webhook";
export * from "./agents/agent";
export * from "./loops/foreach";
export * from "./loops/until";
export * from "./loops/while";
import { AgentNode } from "./agents/agent";
export * from "./boundary/input-value";
export * from "./manifests";
import type { GraphNodeClass } from "./base";

import { BreakFlowNode } from "./flow-control/break";
import { ErrorBoundaryFlowNode } from "./flow-control/error-boundary";
import { HumanApprovalFlowNode } from "./flow-control/human-approval";
import { IfFlowNode } from "./flow-control/if";
import { ParallelFlowNode } from "./flow-control/parallel";
import { SwitchFlowNode } from "./flow-control/switch";
import { CodeNode } from "./utility/code";
import { DelayFlowNode } from "./utility/delay";
import { LogFlowNode } from "./utility/log";
import { MapNode } from "./utility/map";
import { MergeFlowNode } from "./utility/merge";
import { ReturnFlowNode } from "./utility/return";
import { UtilityLogNode } from "./utility/utility-log";
import { ChatTriggerNode } from "./triggers/chat";
import { EventTriggerNode } from "./triggers/event";
import { FormTriggerNode } from "./triggers/form";
import { ManualTriggerNode } from "./triggers/manual";
import { ScheduleTriggerNode } from "./triggers/schedule";
import { WebhookTriggerNode } from "./triggers/webhook";
import { GraphForeachLoopNode } from "./loops/foreach";
import { GraphUntilLoopNode } from "./loops/until";
import { GraphWhileLoopNode } from "./loops/while";
import { GraphInputValueNode } from "./boundary/input-value";

/**
 * All built-in trigger node constructors.
 */
export const GRAPH_TRIGGER_NODES = [
  ManualTriggerNode,
  WebhookTriggerNode,
  ScheduleTriggerNode,
  EventTriggerNode,
  FormTriggerNode,
  ChatTriggerNode,
] as const;

/**
 * All built-in flow-control node constructors (branching/routing/looping/
 * termination semantics).
 */
export const GRAPH_FLOW_CONTROL_NODES = [
  IfFlowNode,
  SwitchFlowNode,
  ParallelFlowNode,
  MergeFlowNode,
  DelayFlowNode,
  ErrorBoundaryFlowNode,
  HumanApprovalFlowNode,
  ReturnFlowNode,
  LogFlowNode,
  BreakFlowNode,
] as const;

/**
 * All built-in utility node constructors (side-effect/data-transformation
 * semantics — no branching).
 */
export const GRAPH_UTILITY_NODES = [
  CodeNode,
  MapNode,
  UtilityLogNode,
] as const;

/**
 * All built-in loop node constructors (shared declarations of the
 * `core.loop.*` system kinds).
 */
export const GRAPH_LOOP_NODES = [
  GraphForeachLoopNode,
  GraphWhileLoopNode,
  GraphUntilLoopNode,
] as const;

/**
 * All built-in boundary node constructors.
 */
export const GRAPH_BOUNDARY_NODES = [GraphInputValueNode] as const;

/**
 * Kind→class map for every built-in node kind the backend executes
 * (DECAF-50 §4.26 R2-1). The catalogue derives each registration's
 * manifest and executor from the class, so this is the single authority for
 * built-in node behaviour.
 */
export const GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND: Record<string, GraphNodeClass> = {
  "core.trigger.manual": ManualTriggerNode,
  "core.trigger.webhook": WebhookTriggerNode,
  "core.trigger.schedule": ScheduleTriggerNode,
  "core.trigger.event": EventTriggerNode,
  "core.trigger.form": FormTriggerNode,
  "core.trigger.chat": ChatTriggerNode,
  "core.flow.if": IfFlowNode,
  "core.flow.switch": SwitchFlowNode,
  "core.flow.parallel": ParallelFlowNode,
  "core.flow.merge": MergeFlowNode,
  "core.utility.map": MapNode,
  "core.flow.delay": DelayFlowNode,
  "core.flow.errorBoundary": ErrorBoundaryFlowNode,
  "core.flow.humanApproval": HumanApprovalFlowNode,
  "core.flow.return": ReturnFlowNode,
  "core.utility.code": CodeNode,
  "core.flow.log": LogFlowNode,
  "core.utility.log": UtilityLogNode,
  "core.flow.break": BreakFlowNode,
  "core.agent": AgentNode,
  "core.loop.foreach": GraphForeachLoopNode,
  "core.loop.while": GraphWhileLoopNode,
  "core.loop.until": GraphUntilLoopNode,
};
