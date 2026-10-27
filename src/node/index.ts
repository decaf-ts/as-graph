/**
 * @module as-graph/nodes
 * @summary Engine-neutral node kind declarations (DECAF-32 §22.2, DECAF-50
 * Phase A).
 * @description Canonical `@node`-decorated classes for the engine-neutral
 * (local) node kind taxonomy, laid out one node per folder under
 * `node/<category>/<sub>/<node>/node.ts`: triggers (§22.2.1), flow-control and
 * utility nodes (§22.2.2–22.2.3), the three loop kinds
 * (`core.loop.foreach/while/until`, §5.9), the workflow input/output value
 * boundary nodes, and the Stage 2/3 service families — Storage
 * (`core.storage.*`: SQL databases, Redis, RabbitMQ, and S3/GCS/Azure blob),
 * DevOps (`core.devops.*`: crypto, JWT, shell command, FTP, GitHub/GitLab),
 * Comms (`core.comms.*`: Slack, Telegram, Teams, Gmail, Email, Discord,
 * WhatsApp, Microsoft Outlook), the newer IO kinds (`core.io.*`: Airtable,
 * Google Sheets, GraphQL, Spreadsheet File, Confluence, Jira, Google Docs,
 * Google Calendar, Microsoft Excel, Microsoft SharePoint, Convert to File,
 * HTML, HTML Extract, Markdown, XML, and the binary file readers/writer), the
 * Stage 5a Data kinds (`core.data.*`: Aggregate, Item Lists, Compare Datasets,
 * Summarize, Remove Duplicates), and the Stage 5b eventing triggers
 * (`core.trigger.*`: Error, Workflow, RabbitMQ, Redis, SSE, Postgres).
 *
 * This barrel is the engine-neutral catalogue and deliberately carries no
 * Mastra node declarations: the Mastra-owned families (`core.agent` and its
 * tools/skills/scorers/memory/processor/hook/sandbox/RAG/channel/HITL/MCP/voice
 * kinds) live under `src/mastra/nodes/` and are never re-exported here, so the
 * local engine and the shared/browser-safe surface stay free of `@mastra/core`.
 * Shared non-node support (the base class and manifests) lives in
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
export * from "./data/date-time/node";
export * from "./data/data-table/node";
export * from "./data/filter/node";
export * from "./data/limit/node";
export * from "./data/merge/node";
export * from "./data/rename-keys/node";
export * from "./data/set/node";
export * from "./data/sort/node";
export * from "./data/split-out/node";
export * from "./data/aggregate/node";
export * from "./data/item-lists/node";
export * from "./data/compare-datasets/node";
export * from "./data/summarize/node";
export * from "./data/remove-duplicates/node";
export * from "./io/extract-from-file/node";
export * from "./io/http-request/node";
export * from "./io/read-pdf/node";
export * from "./io/read-write-file/node";
export * from "./io/respond-to-webhook/node";
export * from "./storage/database/postgres/node";
export * from "./storage/database/mysql/node";
export * from "./storage/database/mssql/node";
export * from "./storage/redis/node";
export * from "./storage/rabbitmq/node";
export * from "./storage/blob/s3/node";
export * from "./storage/blob/gcs/node";
export * from "./storage/blob/azure/node";
export * from "./comms/slack/node";
export * from "./comms/telegram/node";
export * from "./comms/teams/node";
export * from "./comms/gmail/node";
export * from "./comms/email-send/node";
export * from "./comms/discord/node";
export * from "./comms/whatsapp/node";
export * from "./comms/outlook/node";
export * from "./io/google-sheets/node";
export * from "./io/airtable/node";
export * from "./io/spreadsheet-file/node";
export * from "./io/graphql/node";
export * from "./io/microsoft-excel/node";
export * from "./io/confluence/node";
export * from "./io/jira/node";
export * from "./io/google-docs/node";
export * from "./io/microsoft-sharepoint/node";
export * from "./io/google-calendar/node";
export * from "./io/convert-to-file/node";
export * from "./io/html/node";
export * from "./io/html-extract/node";
export * from "./io/markdown/node";
export * from "./io/xml/node";
export * from "./io/read-binary-file/node";
export * from "./io/read-binary-files/node";
export * from "./io/write-binary-file/node";
export * from "./devops/github/node";
export * from "./devops/gitlab/node";
export * from "./devops/crypto/node";
export * from "./devops/jwt/node";
export * from "./devops/execute-command/node";
export * from "./devops/ftp/node";
export * from "./flow/execute-sub-workflow/node";
export * from "./triggers/execute-workflow/node";
export * from "./triggers/chat/node";
export * from "./triggers/event/node";
export * from "./triggers/form/node";
export * from "./triggers/manual/node";
export * from "./triggers/schedule/node";
export * from "./triggers/webhook/node";
export * from "./triggers/error/node";
export * from "./triggers/workflow/node";
export * from "./triggers/rabbitmq/node";
export * from "./triggers/redis/node";
export * from "./triggers/sse/node";
export * from "./triggers/postgres/node";
export * from "./flow/loop/foreach/node";
export * from "./flow/loop/until/node";
export * from "./flow/loop/while/node";
export * from "./boundary/input/node";
export * from "./boundary/output/node";
export * from "./manifests";
import type { GraphNodeClass } from "./base";

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
import { ErrorTriggerNode } from "./triggers/error/node";
import { WorkflowTriggerNode } from "./triggers/workflow/node";
import { RabbitMqTriggerNode } from "./triggers/rabbitmq/node";
import { RedisTriggerNode } from "./triggers/redis/node";
import { SseTriggerNode } from "./triggers/sse/node";
import { PostgresTriggerNode } from "./triggers/postgres/node";
import { GraphForeachLoopNode } from "./flow/loop/foreach/node";
import { GraphUntilLoopNode } from "./flow/loop/until/node";
import { GraphWhileLoopNode } from "./flow/loop/while/node";
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
 * All built-in data-transformation node constructors (SAA-746 Stage 1).
 */
export const GRAPH_DATA_NODES = [
  SetNode,
  MergeNode,
  FilterNode,
  SplitOutNode,
  DateTimeNode,
  DataTableNode,
  LimitNode,
  SortNode,
  RenameKeysNode,
  AggregateNode,
  ItemListsNode,
  CompareDatasetsNode,
  SummarizeNode,
  RemoveDuplicatesNode,
] as const;

/**
 * All built-in IO node constructors (SAA-746 Stage 1).
 */
export const GRAPH_IO_NODES = [
  HttpRequestNode,
  RespondToWebhookNode,
  ExtractFromFileNode,
  ReadPDFNode,
  ReadWriteFileNode,
  ConvertToFileNode,
  HtmlNode,
  HtmlExtractNode,
  MarkdownNode,
  XmlNode,
  ReadBinaryFileNode,
  ReadBinaryFilesNode,
  WriteBinaryFileNode,
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
  "core.data.set": SetNode,
  "core.data.merge": MergeNode,
  "core.data.filter": FilterNode,
  "core.data.splitOut": SplitOutNode,
  "core.data.aggregate": AggregateNode,
  "core.data.itemLists": ItemListsNode,
  "core.data.compareDatasets": CompareDatasetsNode,
  "core.data.summarize": SummarizeNode,
  "core.data.removeDuplicates": RemoveDuplicatesNode,
  "core.data.dateTime": DateTimeNode,
  "core.data.dataTable": DataTableNode,
  "core.data.limit": LimitNode,
  "core.data.sort": SortNode,
  "core.data.renameKeys": RenameKeysNode,
  "core.io.httpRequest": HttpRequestNode,
  "core.io.respondToWebhook": RespondToWebhookNode,
  "core.io.extractFromFile": ExtractFromFileNode,
  "core.io.readPDF": ReadPDFNode,
  "core.io.readWriteFile": ReadWriteFileNode,
  "core.storage.postgres": PostgresNode,
  "core.storage.mySql": MySqlNode,
  "core.storage.microsoftSql": MicrosoftSqlNode,
  "core.storage.redis": RedisNode,
  "core.storage.rabbitmq": RabbitMqNode,
  "core.storage.s3": S3StorageNode,
  "core.storage.awsS3": AwsS3StorageNode,
  "core.storage.googleCloudStorage": GoogleCloudStorageNode,
  "core.storage.azureStorage": AzureStorageNode,
  "core.devops.crypto": CryptoNode,
  "core.devops.jwt": JwtNode,
  "core.devops.executeCommand": ExecuteCommandNode,
  "core.devops.ftp": FtpNode,
  "core.devops.github": GithubNode,
  "core.devops.gitlab": GitlabNode,
  "core.comms.slack": SlackNode,
  "core.comms.telegram": TelegramNode,
  "core.comms.teams": TeamsNode,
  "core.comms.gmail": GmailNode,
  "core.comms.emailSend": EmailSendNode,
  "core.comms.discord": DiscordNode,
  "core.comms.whatsApp": WhatsAppNode,
  "core.comms.microsoftOutlook": MicrosoftOutlookNode,
  "core.io.googleSheets": GoogleSheetsNode,
  "core.io.airtable": AirtableNode,
  "core.io.spreadsheetFile": SpreadsheetFileNode,
  "core.io.graphql": GraphqlNode,
  "core.io.microsoftExcel": MicrosoftExcelNode,
  "core.io.confluence": ConfluenceNode,
  "core.io.jira": JiraNode,
  "core.io.googleDocs": GoogleDocsNode,
  "core.io.microsoftSharePoint": MicrosoftSharePointNode,
  "core.io.googleCalendar": GoogleCalendarNode,
  "core.io.convertToFile": ConvertToFileNode,
  "core.io.html": HtmlNode,
  "core.io.htmlExtract": HtmlExtractNode,
  "core.io.markdown": MarkdownNode,
  "core.io.xml": XmlNode,
  "core.io.readBinaryFile": ReadBinaryFileNode,
  "core.io.readBinaryFiles": ReadBinaryFilesNode,
  "core.io.writeBinaryFile": WriteBinaryFileNode,
  "core.flow.executeSubWorkflow": ExecuteSubWorkflowNode,
  "core.trigger.executeWorkflow": ExecuteWorkflowTriggerNode,
  "core.trigger.error": ErrorTriggerNode,
  "core.trigger.workflow": WorkflowTriggerNode,
  "core.trigger.rabbitmq": RabbitMqTriggerNode,
  "core.trigger.redis": RedisTriggerNode,
  "core.trigger.sse": SseTriggerNode,
  "core.trigger.postgres": PostgresTriggerNode,
  "core.loop.foreach": GraphForeachLoopNode,
  "core.loop.while": GraphWhileLoopNode,
  "core.loop.until": GraphUntilLoopNode,
};
