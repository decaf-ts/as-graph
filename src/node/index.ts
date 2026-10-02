/**
 * @module as-graph/nodes
 * @summary Shared node kind declarations (DECAF-32 §22.2, DECAF-50 Phase A).
 * @description Canonical `@node`-decorated classes for the ALFRED-5 node kind
 * taxonomy, laid out one node per folder under
 * `node/<category>/<sub>/<node>/node.ts`: triggers (§22.2.1), flow-control and
 * utility nodes (§22.2.2–22.2.3), the Agent node (§21.3), the three loop kinds
 * (`core.loop.foreach/while/until`, §5.9), and the workflow input/output value
 * boundary nodes. Shared non-node support (the base class and manifests) lives in
 * sibling files under the same tree; category styles remain in
 * `@decaf-ts/ui-decorators` (`graph/category-styles`). Consumers
 * (for-angular, ALFRED, etc.) import these declarations to populate node
 * palettes, registries, and reference snapshots.
 */
export * from "./base";
export * from "./flow/break/node";
export * from "./flow/error-boundary/node";
export * from "./flow/human-approval/node";
export * from "./flow/if/node";
export * from "./flow/switch/node";
export * from "./utility/code/node";
export * from "./utility/delay/node";
export * from "./utility/log/node";
export * from "./utility/map/node";
export * from "./utility/utility-log/node";
export * from "./triggers/chat/node";
export * from "./triggers/event/node";
export * from "./triggers/form/node";
export * from "./triggers/manual/node";
export * from "./triggers/schedule/node";
export * from "./triggers/webhook/node";
export * from "./agents/agent/node";
export * from "./flow/loop/foreach/node";
export * from "./flow/loop/until/node";
export * from "./flow/loop/while/node";
export * from "./boundary/input/node";
export * from "./boundary/output/node";
export * from "./manifests";
import type { GraphNodeClass } from "./base";

import { AgentNode } from "./agents/agent/node";
import { BreakFlowNode } from "./flow/break/node";
import { ErrorBoundaryFlowNode } from "./flow/error-boundary/node";
import { HumanApprovalFlowNode } from "./flow/human-approval/node";
import { IfFlowNode } from "./flow/if/node";
import { SwitchFlowNode } from "./flow/switch/node";
import { CodeNode } from "./utility/code/node";
import { DelayFlowNode } from "./utility/delay/node";
import { LogFlowNode } from "./utility/log/node";
import { MapNode } from "./utility/map/node";
import { UtilityLogNode } from "./utility/utility-log/node";
import { ChatTriggerNode } from "./triggers/chat/node";
import { EventTriggerNode } from "./triggers/event/node";
import { FormTriggerNode } from "./triggers/form/node";
import { ManualTriggerNode } from "./triggers/manual/node";
import { ScheduleTriggerNode } from "./triggers/schedule/node";
import { WebhookTriggerNode } from "./triggers/webhook/node";
import { GraphForeachLoopNode } from "./flow/loop/foreach/node";
import { GraphUntilLoopNode } from "./flow/loop/until/node";
import { GraphWhileLoopNode } from "./flow/loop/while/node";
import { GraphInputValueNode } from "./boundary/input/node";
import { GraphOutputValueNode } from "./boundary/output/node";

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
  DelayFlowNode,
  ErrorBoundaryFlowNode,
  HumanApprovalFlowNode,
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
export const GRAPH_BOUNDARY_NODES = [
  GraphInputValueNode,
  GraphOutputValueNode,
] as const;

/**
 * Kind→class map for every built-in node kind the backend executes
 * (DECAF-50 §4.26 R2-1). The catalogue derives each registration's
 * manifest and executor from the class, so this is the single authority for
 * built-in node behaviour.
 */
export const GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND: Record<string, GraphNodeClass> = {
  value: GraphInputValueNode,
  result: GraphOutputValueNode,
  "core.trigger.manual": ManualTriggerNode,
  "core.trigger.webhook": WebhookTriggerNode,
  "core.trigger.schedule": ScheduleTriggerNode,
  "core.trigger.event": EventTriggerNode,
  "core.trigger.form": FormTriggerNode,
  "core.trigger.chat": ChatTriggerNode,
  "core.flow.if": IfFlowNode,
  "core.flow.switch": SwitchFlowNode,
  "core.utility.map": MapNode,
  "core.flow.delay": DelayFlowNode,
  "core.flow.errorBoundary": ErrorBoundaryFlowNode,
  "core.flow.humanApproval": HumanApprovalFlowNode,
  "core.utility.code": CodeNode,
  "core.flow.log": LogFlowNode,
  "core.utility.log": UtilityLogNode,
  "core.flow.break": BreakFlowNode,
  "core.agent": AgentNode,
  "core.loop.foreach": GraphForeachLoopNode,
  "core.loop.while": GraphWhileLoopNode,
  "core.loop.until": GraphUntilLoopNode,
};
