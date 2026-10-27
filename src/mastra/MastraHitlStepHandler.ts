/**
 * @module as-graph/mastra/MastraHitlStepHandler
 * @summary Adapter for the `core.agent.hitl` node on the Mastra engine
 * (SAA-836 M5).
 * @description Binds a human-in-the-loop node to a suspending mastra step with
 * mastra's own suspend/resume semantics (R3) and delegates the node behaviour
 * to {@link AgentHitlNode.execute} through the shared step adapter: the node
 * suspends with its `message`/`prompt` payload and routes the user's input,
 * validated against its declared resume schema (C15), onto the canonical
 * `approved`/`rejected` outputs. Resume requests themselves are authorized
 * upstream by the run service's owner-equality gate and validated by the
 * backend resume guard (SAA-193); this handler only owns the step translation.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { assertMastraResumeSchemaSafe, toMastraZodSchema } from "./MastraSchemaConverter";
import type { MastraNodeStepHandler, MastraNodeStepOptions } from "./types";
import {
  asMastraInputRecord,
  runMastraNodeClass,
  sanitizeMastraNodeOutput,
} from "./nodes/MastraNodeStepAdapter";
import { AgentHitlNode } from "./nodes/hitl/node";

/** The document node kind the HITL handler translates. */
export const GRAPH_MASTRA_HITL_KIND = "core.agent.hitl";

/**
 * Builds the {@link MastraNodeStepHandler} registered for the
 * `core.agent.hitl` kind. The step declares the node's `suspendSchema`
 * (optional, mastra-validates the suspend payload shape) and the required,
 * non-degraded `resumeSchema` (C15); when the step runs without resume data it
 * suspends with the node's message/prompt payload, and the resumed payload is
 * routed to `approved` (or `rejected` on an explicit decline) exactly like the
 * general-engine human-approval translation.
 *
 * @returns The HITL step handler.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE} at
 *   translation time when the node declares a missing or degraded resume
 *   schema, so an unresumable HITL node never reaches execution.
 */
export function createMastraHitlStepHandler(): MastraNodeStepHandler {
  return {
    kind: GRAPH_MASTRA_HITL_KIND,
    createStep: (node: GraphNodeInstance, { stepId }: MastraNodeStepOptions) => {
      const parameters = node.parameters ?? {};
      const suspendSchema = toMastraZodSchema(
        parameters["suspendSchema"] as never
      );
      const resumeSchema = assertMastraResumeSchemaSafe(
        parameters["resumeSchema"] as never
      );
      return createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        suspendSchema: suspendSchema.schema,
        resumeSchema,
        execute: async (args: {
          inputData?: unknown;
          suspend?: (payload?: unknown) => unknown;
          resumeData?: unknown;
        }) =>
          asMastraInputRecord(
            sanitizeMastraNodeOutput(
              await runMastraNodeClass(
                GRAPH_MASTRA_HITL_KIND,
                AgentHitlNode,
                node,
                { stepId: stepId },
                {},
                args
              )
            )
          ),
      });
    },
  };
}
