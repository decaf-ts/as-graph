/**
 * @module as-graph/nodes/manifests
 * @summary Built-in node manifests (DECAF-50 §4.12).
 * @description The catalogue-published JSON manifests for every engine-neutral
 * node kind the backend ships. This is the engine-neutral catalogue and no
 * longer carries Mastra node declarations: the Mastra-owned manifests are
 * published from `src/mastra/nodes/manifests.ts`, so this module never imports
 * a `@mastra/core`-dependent node class. Manifests are derived **at runtime**
 * from the shared `@node`-decorated classes via `graphNodeManifest`, so the
 * served shape is
 * identical to what the Angular palette consumes and no per-node manifest
 * constant is hand-maintained. The loop kinds and the switch node are structural:
 * their published port/parameter shape (loop-body ports, dynamic case ports)
 * cannot be recovered from the class's static decorators alone, so a hand-authored
 * overlay is merged over their compiled base. Aggregated in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS` and indexed by kind in
 * `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND`.
 *
 * Every user-visible string is a locale key resolved from `assets/i18n/en.json`
 * (the node's category organization is mirrored there, with the port wrapper
 * strings under `ports: { <category>: {...} }`).
 */
import type {
  GraphNodeManifest,
  GraphParameterDefinition,
  GraphPortManifest,
} from "../shared/graph";
import {
  compile,
  compileWithManifestMetadata,
} from "./manifest-compile";
import { BreakFlowNode } from "./flow/break/node";
import { ErrorBoundaryFlowNode } from "./flow/error-boundary/node";
import { HumanApprovalFlowNode } from "./flow/human-approval/node";
import { IfFlowNode } from "./flow/if/node";
import { SwitchFlowNode } from "./flow/switch/node";
import { CodeNode } from "./utility/code/node";
import { GraphInputValueNode } from "./boundary/input/node";
import { GraphOutputValueNode } from "./boundary/output/node";
import { DateTimeNode } from "./data/date-time/node";
import { DataTableNode } from "./data/data-table/node";
import { FilterNode } from "./data/filter/node";
import { LimitNode } from "./data/limit/node";
import { MergeNode } from "./data/merge/node";
import { RenameKeysNode } from "./data/rename-keys/node";
import { SetNode } from "./data/set/node";
import { SortNode } from "./data/sort/node";
import { SplitOutNode } from "./data/split-out/node";
import { AggregateNode } from "./data/aggregate/node";
import { ItemListsNode } from "./data/item-lists/node";
import { CompareDatasetsNode } from "./data/compare-datasets/node";
import { SummarizeNode } from "./data/summarize/node";
import { RemoveDuplicatesNode } from "./data/remove-duplicates/node";
import { ExtractFromFileNode } from "./io/extract-from-file/node";
import { HttpRequestNode } from "./io/http-request/node";
import { ReadPDFNode } from "./io/read-pdf/node";
import { ReadWriteFileNode } from "./io/read-write-file/node";
import { RespondToWebhookNode } from "./io/respond-to-webhook/node";
import { ExecuteSubWorkflowNode } from "./flow/execute-sub-workflow/node";
import { ExecuteWorkflowTriggerNode } from "./triggers/execute-workflow/node";
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
import { ErrorTriggerNode } from "./triggers/error/node";
import { WorkflowTriggerNode } from "./triggers/workflow/node";
import { RabbitMqTriggerNode } from "./triggers/rabbitmq/node";
import { RedisTriggerNode } from "./triggers/redis/node";
import { SseTriggerNode } from "./triggers/sse/node";
import { PostgresTriggerNode } from "./triggers/postgres/node";
import { PostgresNode } from "./storage/database/postgres/node";
import { MySqlNode } from "./storage/database/mysql/node";
import { MicrosoftSqlNode } from "./storage/database/mssql/node";
import { RedisNode } from "./storage/redis/node";
import { RabbitMqNode } from "./storage/rabbitmq/node";
import { S3StorageNode, AwsS3StorageNode } from "./storage/blob/s3/node";
import { GoogleCloudStorageNode } from "./storage/blob/gcs/node";
import { AzureStorageNode } from "./storage/blob/azure/node";
import { CryptoNode } from "./devops/crypto/node";
import { JwtNode } from "./devops/jwt/node";
import { ExecuteCommandNode } from "./devops/execute-command/node";
import { FtpNode } from "./devops/ftp/node";
import { SlackNode } from "./comms/slack/node";
import { TelegramNode } from "./comms/telegram/node";
import { TeamsNode } from "./comms/teams/node";
import { GmailNode } from "./comms/gmail/node";
import { EmailSendNode } from "./comms/email-send/node";
import { DiscordNode } from "./comms/discord/node";
import { WhatsAppNode } from "./comms/whatsapp/node";
import { MicrosoftOutlookNode } from "./comms/outlook/node";
import { GoogleSheetsNode } from "./io/google-sheets/node";
import { AirtableNode } from "./io/airtable/node";
import { SpreadsheetFileNode } from "./io/spreadsheet-file/node";
import { GraphqlNode } from "./io/graphql/node";
import { MicrosoftExcelNode } from "./io/microsoft-excel/node";
import { ConfluenceNode } from "./io/confluence/node";
import { JiraNode } from "./io/jira/node";
import { GoogleDocsNode } from "./io/google-docs/node";
import { MicrosoftSharePointNode } from "./io/microsoft-sharepoint/node";
import { GoogleCalendarNode } from "./io/google-calendar/node";
import { ConvertToFileNode } from "./io/convert-to-file/node";
import { HtmlNode } from "./io/html/node";
import { HtmlExtractNode } from "./io/html-extract/node";
import { MarkdownNode } from "./io/markdown/node";
import { XmlNode } from "./io/xml/node";
import { ReadBinaryFileNode } from "./io/read-binary-file/node";
import { ReadBinaryFilesNode } from "./io/read-binary-files/node";
import { WriteBinaryFileNode } from "./io/write-binary-file/node";
import { GithubNode } from "./devops/github/node";
import { GitlabNode } from "./devops/gitlab/node";

/**
 * Builds a single {@link GraphPortManifest} from its id, label, direction,
 * and optional extra fields — the terse constructor used by the structural loop
 * and switch overlays below.
 *
 * @param id - Port identifier (matches the decorated property handle).
 * @param label - Locale key for the port label.
 * @param direction - Port direction (`input` or `output`).
 * @param extra - Optional manifest fields merged over the defaults.
 * @returns The assembled port manifest.
 */
function port(
  id: string,
  label: string,
  direction: "input" | "output",
  extra: Partial<GraphPortManifest> = {}
): GraphPortManifest {
  return { id, label, direction, ...extra };
}




/**
 * Merges the credential-adapter parameter and requirement into a compiled node
 * manifest.
 *
 * Appends a `credentialRef` parameter of the given `credentialType` (referenced
 * by id, always optional at the manifest level — the node's own execution
 * decides whether a credential is mandatory) and records the credential type in
 * the manifest's requirement list, de-duplicating an existing requirement of
 * the same type. Used for every Stage 2/3 node kind that resolves secrets
 * through the ctx-bound node credential resolver instead of inline config.
 *
 * @param manifest - The runtime-derived base manifest to augment.
 * @param credentialType - Credential type id (e.g. `s3`, `github`, `sftp`).
 * @param label - Human-facing label for the credential parameter.
 * @returns The manifest with the credential parameter and requirement merged in.
 */
function withCredential(
  manifest: GraphNodeManifest,
  credentialType: string,
  label: string
): GraphNodeManifest {
  const parameter: GraphParameterDefinition = {
    type: "credential",
    id: "credentialRef",
    label,
    required: false,
    credentialType,
  };
  return {
    ...manifest,
    parameters: [...manifest.parameters, parameter],
    credentials: [
      ...(manifest.credentials ?? []).filter(
        (requirement) => requirement.type !== credentialType
      ),
      { type: credentialType, required: false },
    ],
  };
}

/** Structural overlay for the `core.flow.switch` node: case/default dynamic output ports. */
function switchManifest(base: GraphNodeManifest): GraphNodeManifest {
  return {
    ...base,
    outputs: [],
    parameters: [
      ...base.parameters,
      {
        type: "collection",
        id: "cases",
        label: "graph.node.flow_control.switch.fields.cases.label",
        required: true,
        itemIdPath: "outputPort",
        itemLabelPath: "label",
      },
      {
        type: "boolean",
        id: "hasDefault",
        label: "graph.node.flow_control.switch.fields.hasDefault.label",
        defaultValue: false,
      },
      {
        type: "object",
        id: "switch",
        label: "graph.node.flow_control.switch.fields.switch.label",
        required: false,
      },
    ],
    dynamicPorts: [
      {
        type: "repeatFromParameter",
        parameter: "cases",
        itemIdPath: "outputPort",
        itemLabelPath: "label",
        direction: "output",
        portIdTemplate: "${id}",
        defaultPort: {
          id: "case",
          label: "graph.node.flow_control.switch.ports.output.case.label",
          direction: "output",
          schema: { type: "any" },
        },
      },
      {
        type: "togglePort",
        parameter: "hasDefault",
        equals: true,
        port: {
          id: "default",
          label: "graph.node.flow_control.switch.ports.output.default.label",
          direction: "output",
          schema: { type: "any" },
        },
      },
    ],
  };
}

/** Structural overlay for the `core.flow.if` node: opt-in `else` output port. */
function ifManifest(base: GraphNodeManifest): GraphNodeManifest {
  return {
    ...base,
    dynamicPorts: [
      {
        type: "togglePort",
        parameter: "else",
        equals: true,
        port: {
          id: "else",
          label: "graph.node.flow_control.if.ports.output.else.label",
          direction: "output",
          schema: { type: "any" },
        },
      },
    ],
  };
}

/** Manifest for the `core.loop.foreach` node: runs the loop body once per item (or slice) of the input array. */
const FOREACH_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.foreach",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.foreach.name",
    description: "graph.node.loop.foreach.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-repeat" },
    width: 120,
    height: 140,
    labels: ["loop", "iteration", "foreach"],
  },
  inputs: [
    port("items", "graph.node.loop.foreach.ports.input.items.label", "input", {
      required: true,
      schema: { type: "array", items: { type: "any" } },
    }),
    port("slice", "graph.node.loop.foreach.ports.input.slice.label", "input", {
      schema: { type: "number", integer: true, min: 1 },
    }),
    port("state", "graph.node.loop.foreach.ports.input.state.label", "input", { schema: { type: "any" } }),
  ],
  outputs: [
    port("results", "graph.node.loop.foreach.ports.output.results.label", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("completed", "graph.node.loop.foreach.ports.output.completed.label", "output", {
      schema: { type: "array", items: { type: "any" } },
    }),
    port("iterations", "graph.node.loop.foreach.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
    port("broken", "graph.node.loop.foreach.ports.output.broken.label", "output", { schema: { type: "boolean" } }),
    port("state", "graph.node.loop.foreach.ports.output.state.label", "output", { schema: { type: "any" } }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.foreach.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.foreach.fields.condition.label" },
    { type: "string", id: "itemPort", label: "graph.node.loop.foreach.fields.itemPort.label" },
    { type: "string", id: "resultPort", label: "graph.node.loop.foreach.fields.resultPort.label" },
    { type: "string", id: "statePort", label: "graph.node.loop.foreach.fields.statePort.label" },
    { type: "number", id: "slice", label: "graph.node.loop.foreach.fields.slice.label", integer: true, min: 1 },
  ],
};

/** Manifest for the `core.loop.while` node: repeats the loop body while the condition holds. */
const WHILE_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.while",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.while.name",
    description: "graph.node.loop.while.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-arrows-loop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "while"],
  },
  inputs: [port("state", "graph.node.loop.while.ports.input.state.label", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "graph.node.loop.while.ports.output.state.label", "output", { schema: { type: "any" } }),
    port("iterations", "graph.node.loop.while.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.while.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.while.fields.condition.label", required: true },
    { type: "string", id: "statePort", label: "graph.node.loop.while.fields.statePort.label" },
    { type: "string", id: "inputPort", label: "graph.node.loop.while.fields.inputPort.label" },
    { type: "string", id: "outputPort", label: "graph.node.loop.while.fields.outputPort.label" },
  ],
};

/** Manifest for the `core.loop.until` node: repeats the loop body until the condition holds. */
const UNTIL_MANIFEST: GraphNodeManifest = {
  kind: "core.loop.until",
  capabilities: ["loop"],
  display: {
    name: "graph.node.loop.until.name",
    description: "graph.node.loop.until.description",
    category: "Loop",
    color: "#eab308",
    icon: { type: "catalogue", name: "ti-player-stop" },
    width: 120,
    height: 140,
    labels: ["loop", "conditional", "until"],
  },
  inputs: [port("state", "graph.node.loop.until.ports.input.state.label", "input", { schema: { type: "any" } })],
  outputs: [
    port("state", "graph.node.loop.until.ports.output.state.label", "output", { schema: { type: "any" } }),
    port("iterations", "graph.node.loop.until.ports.output.iterations.label", "output", {
      schema: { type: "number", integer: true, min: 0 },
    }),
  ],
  parameters: [
    { type: "number", id: "maxIterations", label: "graph.node.loop.until.fields.maxIterations.label", integer: true, min: 1 },
    { type: "object", id: "condition", label: "graph.node.loop.until.fields.condition.label", required: true },
    { type: "string", id: "statePort", label: "graph.node.loop.until.fields.statePort.label" },
    { type: "string", id: "inputPort", label: "graph.node.loop.until.fields.inputPort.label" },
    { type: "string", id: "outputPort", label: "graph.node.loop.until.fields.outputPort.label" },
  ],
};

/** All built-in node manifests, in catalogue display order (derived at runtime from `@node` metadata). */
export const GRAPH_BUILT_IN_NODE_MANIFESTS: GraphNodeManifest[] = [
  compile(GraphInputValueNode),
  compile(GraphOutputValueNode),
  compile(DateTimeNode),
  compile(DataTableNode),
  compile(FilterNode),
  compile(LimitNode),
  compile(MergeNode),
  compile(RenameKeysNode),
  compile(SetNode),
  compile(SortNode),
  compile(SplitOutNode),
  compile(AggregateNode),
  compile(ItemListsNode),
  compile(CompareDatasetsNode),
  compile(SummarizeNode),
  compile(RemoveDuplicatesNode),
  compile(ExtractFromFileNode),
  compile(HttpRequestNode),
  compile(ReadPDFNode),
  compile(ReadWriteFileNode),
  withCredential(
    compile(PostgresNode),
    "postgres",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(MySqlNode),
    "mysql",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(MicrosoftSqlNode),
    "mssql",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(RedisNode),
    "redis",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(RabbitMqNode),
    "rabbitmq",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(S3StorageNode),
    "s3",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(AwsS3StorageNode),
    "s3",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GoogleCloudStorageNode),
    "gcs",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(AzureStorageNode),
    "azure-blob",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(CryptoNode),
    "crypto",
    "graph.node.devops.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(JwtNode),
    "jwt",
    "graph.node.devops.common.fields.credentialRef.label"
  ),
  compileWithManifestMetadata(ExecuteCommandNode, {
    danger: true,
    requiresOptIn: true,
    dangerReason:
      "Executes arbitrary shell commands with the host process privileges; expose only behind an explicit operator opt-in.",
  }),
  withCredential(
    compile(FtpNode),
    "sftp",
    "graph.node.devops.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GithubNode),
    "github",
    "graph.node.devops.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GitlabNode),
    "gitlab",
    "graph.node.devops.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(SlackNode),
    "slack",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(TelegramNode),
    "telegram",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(TeamsNode),
    "teams",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GmailNode),
    "gmail",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(EmailSendNode),
    "email",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(DiscordNode),
    "discord",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(WhatsAppNode),
    "whatsapp",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(MicrosoftOutlookNode),
    "microsoft-outlook",
    "graph.node.comms.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GoogleSheetsNode),
    "google-sheets",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(AirtableNode),
    "airtable",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GraphqlNode),
    "graphql",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(MicrosoftExcelNode),
    "microsoft-excel",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(ConfluenceNode),
    "confluence",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(JiraNode),
    "jira",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GoogleDocsNode),
    "google-docs",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(MicrosoftSharePointNode),
    "microsoft-sharepoint",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(GoogleCalendarNode),
    "google-calendar",
    "graph.node.io.common.fields.credentialRef.label"
  ),
  compile(SpreadsheetFileNode),
  compile(ConvertToFileNode),
  compile(HtmlNode),
  compile(HtmlExtractNode),
  compile(MarkdownNode),
  compile(XmlNode),
  compile(ReadBinaryFileNode),
  compile(ReadBinaryFilesNode),
  compile(WriteBinaryFileNode),
  compile(RespondToWebhookNode),
  compile(ExecuteSubWorkflowNode),
  compile(ExecuteWorkflowTriggerNode),
  compile(ErrorTriggerNode),
  compile(WorkflowTriggerNode),
  withCredential(
    compile(RabbitMqTriggerNode),
    "rabbitmq",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(RedisTriggerNode),
    "redis",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(SseTriggerNode),
    "token",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  withCredential(
    compile(PostgresTriggerNode),
    "postgres",
    "graph.node.storage.common.fields.credentialRef.label"
  ),
  compile(ManualTriggerNode),
  compile(WebhookTriggerNode),
  compile(ScheduleTriggerNode),
  compile(EventTriggerNode),
  compile(FormTriggerNode),
  compile(ChatTriggerNode),
  ifManifest(compile(IfFlowNode)),
  switchManifest(compile(SwitchFlowNode)),
  compile(MapNode),
  compile(DelayFlowNode),
  compile(ErrorBoundaryFlowNode),
  compile(HumanApprovalFlowNode),
  compile(CodeNode),
  compile(LogFlowNode),
  compile(UtilityLogNode),
  compile(BreakFlowNode),
  FOREACH_MANIFEST,
  WHILE_MANIFEST,
  UNTIL_MANIFEST,
];

/** Built-in manifests indexed by node `kind` — the source for built-in catalogue registrations. */
export const GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND: Record<
  string,
  GraphNodeManifest
> = Object.fromEntries(
  GRAPH_BUILT_IN_NODE_MANIFESTS.map((manifest) => [manifest.kind, manifest])
);
