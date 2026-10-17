/**
 * @module as-graph/mastra/MastraScheduleTrigger
 * @summary Mastra declarative-schedule translation for the
 * `core.trigger.schedule` kind (SAA-836 M6).
 * @description Resolves every schedule trigger node of a document into a
 * mastra declarative `WorkflowScheduleConfig` so the compiled workflow is
 * created with mastra's `schedule` input — the mastra scheduler then starts a
 * run on each cron fire ("Declaring a `schedule` registers cron fires with
 * the Mastra scheduler"). The cron expression and timezone resolve from the
 * node's parameters (string or `{ expression }` shape) with the node's
 * `trigger` metadata as fallback; validation is mastra's own `validateCron`,
 * not a local parser. A schedule trigger that declares no resolvable cron
 * fails closed with {@link GRAPH_MASTRA_SCHEDULE_UNAVAILABLE} — a schedule
 * trigger without a schedule is a misconfiguration, never a silent no-op.
 */
import { validateCron } from "@mastra/core/workflows";
import type { WorkflowScheduleConfig } from "@mastra/core/workflows";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_SCHEDULE_UNAVAILABLE } from "./types";

/** The document node kind the declarative-schedule translation covers. */
export const GRAPH_MASTRA_SCHEDULE_TRIGGER_KIND = "core.trigger.schedule";

/**
 * Resolves the cron expression a schedule trigger node declares. Accepts the
 * parameter as a plain string or as mastra's `{ expression }` shape, with the
 * node's `trigger` metadata (`schedule`) as fallback.
 *
 * @param node - The schedule trigger node.
 * @returns The cron expression, or `undefined` when none is declared.
 */
function mastraScheduleCronOf(node: GraphNodeInstance): string | undefined {
  const parameters = node.parameters ?? {};
  const raw = parameters["cron"];
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const expression = (raw as Record<string, unknown>)["expression"];
    if (typeof expression === "string" && expression.trim() !== "") {
      return expression;
    }
  }
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const trigger = metadata?.["trigger"];
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const schedule = (trigger as Record<string, unknown>)["schedule"];
    if (typeof schedule === "string" && schedule.trim() !== "") return schedule;
  }
  return undefined;
}

/**
 * Resolves the IANA timezone a schedule trigger node declares, from the
 * node's parameters with the node's `trigger` metadata as fallback.
 *
 * @param node - The schedule trigger node.
 * @returns The timezone, or `undefined` when none is declared.
 */
function mastraScheduleTimezoneOf(node: GraphNodeInstance): string | undefined {
  const parameters = node.parameters ?? {};
  if (typeof parameters["timezone"] === "string") {
    return parameters["timezone"] as string;
  }
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const trigger = metadata?.["trigger"];
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const timezone = (trigger as Record<string, unknown>)["timezone"];
    if (typeof timezone === "string") return timezone;
  }
  return undefined;
}

/**
 * Resolves every schedule trigger node of a document into mastra declarative
 * schedule configs. Each config carries the node id as its stable schedule id
 * (scoped to the workflow, stable across deploys) and the resolved cron and
 * timezone; the cron is validated with mastra's `validateCron` so an invalid
 * expression fails closed at translation instead of surfacing as a scheduler
 * boot failure.
 *
 * @param document - The canonical document to translate.
 * @returns The declarative schedule configs, or `undefined` when the document
 *   declares no schedule trigger node.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_SCHEDULE_UNAVAILABLE} when
 *   a schedule trigger node declares no resolvable cron or mastra rejects the
 *   cron/timezone combination.
 */
export function mastraScheduleConfigsOf(
  document: GraphWorkflowDocument
): WorkflowScheduleConfig[] | undefined {
  const triggers = document.nodes.filter(
    (node) => node.kind === GRAPH_MASTRA_SCHEDULE_TRIGGER_KIND
  );
  if (triggers.length === 0) return undefined;
  const configs: WorkflowScheduleConfig[] = [];
  for (const node of triggers) {
    const cron = mastraScheduleCronOf(node);
    if (!cron) {
      throw new GraphExecutionError(
        `Schedule trigger node '${node.id}' declares no cron expression, so no schedule can fire the workflow`,
        GRAPH_MASTRA_SCHEDULE_UNAVAILABLE,
        { nodeId: node.id, kind: node.kind }
      );
    }
    const timezone = mastraScheduleTimezoneOf(node);
    try {
      validateCron(cron, timezone);
    } catch (error: unknown) {
      throw new GraphExecutionError(
        `Schedule trigger node '${node.id}' declares an invalid schedule: ${String(
          error instanceof Error ? error.message : error
        )}`,
        GRAPH_MASTRA_SCHEDULE_UNAVAILABLE,
        { nodeId: node.id, kind: node.kind }
      );
    }
    configs.push({
      id: node.id,
      cron,
      ...(timezone ? { timezone } : {}),
    });
  }
  return configs;
}
