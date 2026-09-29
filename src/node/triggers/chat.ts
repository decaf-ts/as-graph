/**
 * @module as-graph/nodes/triggers/chat
 * @summary Chat trigger node declaration (DECAF-32 §22.2.1).
 * @description Chat trigger — chat message entrypoint; message/sessionId/
 * userId schema.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

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
    title: "Chat trigger",
    description:
      "Starts the workflow when a chat message is received. Emits message, sessionId, and userId.",
    trigger: {
      type: "chat",
    },
  },
})
@model()
export class ChatTriggerNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return {
      message: request.inputs["message"] ?? null,
      sessionId: request.inputs["sessionId"] ?? null,
      userId: request.inputs["userId"] ?? null,
    };
  }

  @required()
  @uielement("input", {
    label: "Message",
    placeholder: "Incoming chat message",
  })
  @output({ handle: "message" })
  message!: string;

  @required()
  @uielement("input", {
    label: "Session ID",
    placeholder: "Chat session identifier",
  })
  @output({ handle: "sessionId" })
  sessionId!: string;

  @required()
  @uielement("input", { label: "User ID", placeholder: "Chat user identifier" })
  @output({ handle: "userId" })
  userId!: string;
}
