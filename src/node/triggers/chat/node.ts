/**
 * @module as-graph/nodes/triggers/chat
 * @summary Chat trigger node declaration (DECAF-32 §22.2.1).
 * @description Chat trigger — chat message entrypoint; message/sessionId/
 * userId schema.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the chat trigger (none — it is an entrypoint). */
export type ChatTriggerInput = Record<string, unknown>;

/** Outputs produced by the chat trigger. */
export interface ChatTriggerOutput {
  message: unknown;
  sessionId: unknown;
  userId: unknown;
}

/**
 * Chat trigger node: chat message entrypoint with a message/sessionId/userId schema.
 */
@node("core.trigger.chat", {
  kind: "core.trigger.chat",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-message-circle",
  width: 96,
  height: 96,
  labels: ["trigger", "chat", "entrypoint"],
  metadata: {
    title: "graph.node.trigger.chat.name",
    description:
      "graph.node.trigger.chat.description",
    trigger: {
      type: "chat",
    },
  },
})
@model()
export class ChatTriggerNode extends GraphNode<
  ChatTriggerInput,
  ChatTriggerOutput
> {
  /**
   * Returns the chat message/session/user context supplied by the run caller
   * under the trigger's output schema.
   *
   * @param {GraphNodeExecutionRequest<ChatTriggerInput>} request - Execution request carrying the chat trigger payload.
   * @return {GraphExecutionValues} The `message`/`sessionId`/`userId` output values (null when absent).
   */
  override execute(
    request: GraphNodeExecutionRequest<ChatTriggerInput>
  ): GraphExecutionValues {
    return {
      message: request.inputs["message"] ?? null,
      sessionId: request.inputs["sessionId"] ?? null,
      userId: request.inputs["userId"] ?? null,
    };
  }

  /** Output carrying the incoming chat message. */
  @required()
  @output({ handle: "message" })
  message!: string;

  /** Output carrying the chat session identifier. */
  @required()
  @output({ handle: "sessionId" })
  sessionId!: string;

  /** Output carrying the chat user identifier. */
  @required()
  @output({ handle: "userId" })
  userId!: string;
}
