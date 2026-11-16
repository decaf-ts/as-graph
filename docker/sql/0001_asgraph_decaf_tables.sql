-- 0001_asgraph_decaf_tables.sql
-- Bootstrap DDL for the @decaf-ts/as-graph decaf tables, GENERATED from the
-- TypeORM entity metadata of the durable adapter by
-- `as-graph/scripts/generate-asgraph-ddl.cjs` — do not edit by hand;
-- regenerate after a model change. `tests/integration/graph/
-- TypeormGraphAdapterPostgres.test.ts` fails when a model and this schema
-- disagree.
--
-- Tables: graph runs/events/workflows/nodes/values/data tables, the binary
-- index (graph_binary, graph_binary_holder), tenant quotas, and the Decaf
-- core TaskEngine tables (tasks, task_event) for GRAPH_RUN_QUEUE=task-engine.
-- Shipped with @decaf-ts/as-graph (`docker/sql/`): applied by its own
-- integration setup and by deployments' bootstrap migration (as the
-- migrator role). Idempotent (IF NOT EXISTS).

CREATE SCHEMA IF NOT EXISTS asgraph;
SET search_path = asgraph;

CREATE TABLE IF NOT EXISTS "asgraph"."graph_workflow" ("workflowId" character varying NOT NULL, "name" character varying, "document" jsonb, "owner" character varying, "snapshot" jsonb, CONSTRAINT "PK_c0de0a3d5686a50ed80fce78ea6" PRIMARY KEY ("workflowId"));
CREATE TABLE IF NOT EXISTS "asgraph"."graph_run" ("runId" character varying NOT NULL, "workflowId" character varying, "owner" character varying, "status" character varying, "documentFingerprint" character varying, "workerId" character varying, "heartbeatAt" TIMESTAMP, "suspendedAt" TIMESTAMP, "attempt" integer, "callerKey" character varying, "idempotencyKey" character varying, "requestHash" character varying, "storedBytes" bigint, "inputs" jsonb, "result" jsonb, "error" jsonb, "createdAt" TIMESTAMP, "startedAt" TIMESTAMP, "finishedAt" TIMESTAMP, CONSTRAINT "PK_f1f726366d4d0d51deca2142c38" PRIMARY KEY ("runId"));
CREATE INDEX IF NOT EXISTS "IDX_ff24d57aed331eff6d36b1df36" ON "asgraph"."graph_run"  ("workflowId", "createdAt");
CREATE INDEX IF NOT EXISTS "IDX_18c47a89097e100ad52425ee7e" ON "asgraph"."graph_run"  ("workflowId");
CREATE INDEX IF NOT EXISTS "IDX_6785baad9ac6e9ded4700e7f2e" ON "asgraph"."graph_run"  ("status", "finishedAt");
CREATE INDEX IF NOT EXISTS "IDX_73a997cb0df9f4f0088bbe32d1" ON "asgraph"."graph_run"  ("status");
CREATE INDEX IF NOT EXISTS "IDX_92bdc325d47b913a589eb5a2dd" ON "asgraph"."graph_run"  ("heartbeatAt");
CREATE INDEX IF NOT EXISTS "IDX_92c28d627978bb237a75fc1a6e" ON "asgraph"."graph_run"  ("callerKey", "createdAt");
CREATE INDEX IF NOT EXISTS "IDX_5868b1544fb756dc46f1d61730" ON "asgraph"."graph_run"  ("callerKey", "status");
CREATE INDEX IF NOT EXISTS "IDX_1d723b41ad2e43fd45ed1f96a5" ON "asgraph"."graph_run"  ("callerKey");
CREATE INDEX IF NOT EXISTS "IDX_1dc9ab4bffe761e70a0c0cbdf3" ON "asgraph"."graph_run"  ("idempotencyKey");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_node" ("kind" character varying NOT NULL, "name" character varying, "category" character varying, "group" character varying, "description" character varying, "manifest" jsonb, CONSTRAINT "PK_911e170504e1105afc1cb34340c" PRIMARY KEY ("kind"));
CREATE INDEX IF NOT EXISTS "IDX_14e19749e8c095859e37274d2c" ON "asgraph"."graph_node"  ("name");
CREATE INDEX IF NOT EXISTS "IDX_0556fced6644011ced5f329f12" ON "asgraph"."graph_node"  ("category");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_run_event" ("id" character varying NOT NULL, "runId" character varying, "workflowId" character varying, "sequence" integer, "type" character varying, "timestamp" character varying, "nodeId" character varying, "edgeId" character varying, "payload" jsonb, "error" jsonb, "parentRunId" character varying, "path" jsonb, CONSTRAINT "PK_f205d426cd6177e9b5a4383e086" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_d9c9ae4ade39dd31738204f408" ON "asgraph"."graph_run_event"  ("runId", "sequence");
CREATE INDEX IF NOT EXISTS "IDX_c4fe5be6caa3c518deda359aa1" ON "asgraph"."graph_run_event"  ("runId");
CREATE INDEX IF NOT EXISTS "IDX_96249b42b4d57a19cfbbbd4a86" ON "asgraph"."graph_run_event"  ("sequence");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_value" ("id" character varying NOT NULL, "workflowId" character varying, "nodeId" character varying, "fingerprint" character varying, "namespace" character varying, "version" character varying, "pinned" boolean, "outputs" jsonb, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, "expiresAt" TIMESTAMP, "metadata" jsonb, CONSTRAINT "PK_c32b67538eb24f779f8b54c63c8" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_8ddd6120b3e1772b577c141b7d" ON "asgraph"."graph_value"  ("workflowId");
CREATE INDEX IF NOT EXISTS "IDX_40d69dce586e2e31228618560b" ON "asgraph"."graph_value"  ("nodeId");
CREATE INDEX IF NOT EXISTS "IDX_38d47a4238fcb36c7aec82084a" ON "asgraph"."graph_value"  ("pinned", "expiresAt");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_replay_snapshot" ("id" character varying NOT NULL, "runId" character varying, "workflowId" character varying, "documentFingerprint" character varying, "version" integer, "status" character varying, "payload" jsonb, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, CONSTRAINT "PK_03951abec88a66a829d55a8399a" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_03951abec88a66a829d55a8399" ON "asgraph"."mastra_replay_snapshot"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_46041752736f6b3f14a03835dc" ON "asgraph"."mastra_replay_snapshot"  ("runId");
CREATE INDEX IF NOT EXISTS "IDX_616e06d3553106f15d8ef1a600" ON "asgraph"."mastra_replay_snapshot"  ("workflowId");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_cache_entry" ("id" character varying NOT NULL, "workflowId" character varying, "fingerprint" character varying, "compiledAt" TIMESTAMP, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, CONSTRAINT "PK_befb5038868399af487e7df9b3d" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_befb5038868399af487e7df9b3" ON "asgraph"."mastra_cache_entry"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_f2e0cc6e2a685691ad59f1cff3" ON "asgraph"."mastra_cache_entry"  ("workflowId");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_eval_experiment" ("experimentId" character varying NOT NULL, "name" character varying, "description" character varying, "datasetId" character varying, "datasetVersion" integer, "targetType" character varying, "targetId" character varying, "scorerIds" jsonb, "status" character varying, "totalItems" integer, "succeededCount" integer, "failedCount" integer, "skippedCount" integer, "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "createdAt" TIMESTAMP, CONSTRAINT "PK_6bca669a87455bf13a38587bf1c" PRIMARY KEY ("experimentId"));
CREATE INDEX IF NOT EXISTS "IDX_6bca669a87455bf13a38587bf1" ON "asgraph"."mastra_eval_experiment"  ("experimentId");
CREATE INDEX IF NOT EXISTS "IDX_53aceb141e1178a427a56b2a6d" ON "asgraph"."mastra_eval_experiment"  ("datasetId");
CREATE INDEX IF NOT EXISTS "IDX_cde2e50ff5a2fd5a847808e833" ON "asgraph"."mastra_eval_experiment"  ("targetId");
CREATE INDEX IF NOT EXISTS "IDX_8c97aaa65ca17df1b7e8e9736d" ON "asgraph"."mastra_eval_experiment"  ("status");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_eval_result" ("resultId" character varying NOT NULL, "experimentId" character varying, "itemId" character varying, "itemDatasetVersion" integer, "attempt" integer, "retryCount" integer, "status" character varying, "input" jsonb, "output" jsonb, "groundTruth" jsonb, "error" jsonb, "traceId" character varying, "tags" jsonb, "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "createdAt" TIMESTAMP, CONSTRAINT "PK_aa179a287c114d96b2bcb60d71d" PRIMARY KEY ("resultId"));
CREATE INDEX IF NOT EXISTS "IDX_aa179a287c114d96b2bcb60d71" ON "asgraph"."mastra_eval_result"  ("resultId");
CREATE INDEX IF NOT EXISTS "IDX_ac9510e97396932ac3f80274a0" ON "asgraph"."mastra_eval_result"  ("experimentId");
CREATE INDEX IF NOT EXISTS "IDX_196a6e5802ff0ad7bfbcec61d5" ON "asgraph"."mastra_eval_result"  ("status");
CREATE INDEX IF NOT EXISTS "IDX_2817ea325794e0ee579525a77c" ON "asgraph"."mastra_eval_result"  ("traceId");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_run_metric" ("runId" character varying NOT NULL, "workflowId" character varying, "resourceId" character varying, "status" character varying, "snapshot" jsonb, "createdAt" TIMESTAMP, CONSTRAINT "PK_d89a64eb58be6ae12e3dc59c772" PRIMARY KEY ("runId"));
CREATE INDEX IF NOT EXISTS "IDX_d89a64eb58be6ae12e3dc59c77" ON "asgraph"."mastra_run_metric"  ("runId");
CREATE INDEX IF NOT EXISTS "IDX_eee8a873d1eebdcdb01e9a1ac3" ON "asgraph"."mastra_run_metric"  ("workflowId");
CREATE INDEX IF NOT EXISTS "IDX_093c6f5bdebfd4a7dac18c12ad" ON "asgraph"."mastra_run_metric"  ("status");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_score_metric" ("scoreId" character varying NOT NULL, "runId" character varying, "workflowId" character varying, "scorerId" character varying, "score" integer, "reason" character varying, "input" jsonb, "output" jsonb, "createdAt" TIMESTAMP, CONSTRAINT "PK_c12df1352b67aad25212e76e569" PRIMARY KEY ("scoreId"));
CREATE INDEX IF NOT EXISTS "IDX_c12df1352b67aad25212e76e56" ON "asgraph"."mastra_score_metric"  ("scoreId");
CREATE INDEX IF NOT EXISTS "IDX_f3f71d1e84c97f61febce29a69" ON "asgraph"."mastra_score_metric"  ("runId");
CREATE INDEX IF NOT EXISTS "IDX_087751a3311e5bd6c198dea37d" ON "asgraph"."mastra_score_metric"  ("workflowId");
CREATE TABLE IF NOT EXISTS "asgraph"."mastra_trace_metric" ("spanId" character varying NOT NULL, "traceId" character varying, "runId" character varying, "workflowId" character varying, "name" character varying, "spanType" character varying, "status" character varying, "summary" jsonb, "startedAt" TIMESTAMP, "endedAt" TIMESTAMP, CONSTRAINT "PK_3521c93bdc998a637dc2810c7d9" PRIMARY KEY ("spanId"));
CREATE INDEX IF NOT EXISTS "IDX_3521c93bdc998a637dc2810c7d" ON "asgraph"."mastra_trace_metric"  ("spanId");
CREATE INDEX IF NOT EXISTS "IDX_8a7d37ad44c1fde35b43d80ad6" ON "asgraph"."mastra_trace_metric"  ("traceId");
CREATE INDEX IF NOT EXISTS "IDX_4d859f673c8668d755a389f89b" ON "asgraph"."mastra_trace_metric"  ("runId");
CREATE INDEX IF NOT EXISTS "IDX_ad552c14c2c8a0537ee004816a" ON "asgraph"."mastra_trace_metric"  ("workflowId");
CREATE INDEX IF NOT EXISTS "IDX_144d3b4badaca0dca6ad752e99" ON "asgraph"."mastra_trace_metric"  ("status");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_data_table" ("id" character varying NOT NULL, "tableName" character varying, "rowId" character varying, "data" jsonb, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, CONSTRAINT "PK_57907fbddc213aaef3c99799c32" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_57907fbddc213aaef3c99799c3" ON "asgraph"."graph_data_table"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_9b4754a8cf4cae987ee267a5df" ON "asgraph"."graph_data_table"  ("tableName");
CREATE INDEX IF NOT EXISTS "IDX_68b8297ced6ea53ee4f4c77623" ON "asgraph"."graph_data_table"  ("rowId");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_binary" ("id" character varying NOT NULL, "scope" character varying, "binaryId" character varying, "fileName" character varying, "mimeType" character varying, "byteLength" bigint, "path" character varying, "deletePendingAt" TIMESTAMP, CONSTRAINT "PK_d7c1469a5e7135e58cc65617a2c" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_d7c1469a5e7135e58cc65617a2" ON "asgraph"."graph_binary"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_57dbb6ebb2d816d35a42c92b41" ON "asgraph"."graph_binary"  ("scope", "deletePendingAt");
CREATE INDEX IF NOT EXISTS "IDX_0ccaf89a43f2d8490bc67c828d" ON "asgraph"."graph_binary"  ("scope");
CREATE INDEX IF NOT EXISTS "IDX_e7b68b9b35ca3c22ec588e7191" ON "asgraph"."graph_binary"  ("binaryId");
CREATE INDEX IF NOT EXISTS "IDX_1d9b6e868d6dc73111a50c385c" ON "asgraph"."graph_binary"  ("deletePendingAt");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_binary_holder" ("id" character varying NOT NULL, "scope" character varying, "binaryId" character varying, "holder" character varying, CONSTRAINT "PK_aa4fec6ec3a5ffc8ce40998ad2b" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_aa4fec6ec3a5ffc8ce40998ad2" ON "asgraph"."graph_binary_holder"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_6160a86e242ef39171ee7d2bb5" ON "asgraph"."graph_binary_holder"  ("scope", "binaryId");
CREATE INDEX IF NOT EXISTS "IDX_c463540e220eafa1e05219e8e6" ON "asgraph"."graph_binary_holder"  ("scope", "holder");
CREATE INDEX IF NOT EXISTS "IDX_dd0c37072435706d6ae81e5eb4" ON "asgraph"."graph_binary_holder"  ("scope");
CREATE INDEX IF NOT EXISTS "IDX_d14edb676a56623d32a171384c" ON "asgraph"."graph_binary_holder"  ("binaryId");
CREATE INDEX IF NOT EXISTS "IDX_a2f3460a06aef6e2f8ff0af90c" ON "asgraph"."graph_binary_holder"  ("holder");
CREATE TABLE IF NOT EXISTS "asgraph"."graph_tenant_quota" ("tenant" character varying NOT NULL, "maxActiveRuns" integer, "maxRunsPerMinute" integer, "maxStoredBytes" bigint, CONSTRAINT "PK_9ab149291c9dd9e3a901a0a3505" PRIMARY KEY ("tenant"));
CREATE INDEX IF NOT EXISTS "IDX_9ab149291c9dd9e3a901a0a350" ON "asgraph"."graph_tenant_quota"  ("tenant");
CREATE TABLE IF NOT EXISTS "asgraph"."tasks" ("id" character varying NOT NULL, "atomicity" character varying, "classification" character varying, "name" character varying, "lock" character varying, "status" character varying, "input" character varying, "output" character varying, "error" character varying, "attempt" integer, "maxAttempts" integer, "backoff" character varying, "nextRunAt" TIMESTAMP, "scheduledTo" TIMESTAMP, "dependencies" character varying, "leaseOwner" character varying, "leaseExpiry" TIMESTAMP, "steps" character varying, "currentStep" integer, "stepResults" character varying, "logTail" character varying, "createdAt" TIMESTAMP DEFAULT now(), "updatedAt" TIMESTAMP DEFAULT now(), "createdBy" character varying, "updatedBy" character varying, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_8d12ff38fcc62aaba2cab74877" ON "asgraph"."tasks"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_6d209d1655d0dfdd3804b62c4c" ON "asgraph"."tasks"  ("atomicity");
CREATE INDEX IF NOT EXISTS "IDX_52c6836e97dd5b3314ed11bd30" ON "asgraph"."tasks"  ("classification");
CREATE INDEX IF NOT EXISTS "IDX_396d500ff7f1b82771ddd812fd" ON "asgraph"."tasks"  ("name");
CREATE INDEX IF NOT EXISTS "IDX_d3f132bb9753563a9cd7b15289" ON "asgraph"."tasks"  ("status", "scheduledTo");
CREATE INDEX IF NOT EXISTS "IDX_8f2f716f6a2cfc5a2abaacf363" ON "asgraph"."tasks"  ("status", "leaseExpiry");
CREATE INDEX IF NOT EXISTS "IDX_54a6740fc8d124ca098ed237cf" ON "asgraph"."tasks"  ("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "IDX_6086c8dafbae729a930c04d865" ON "asgraph"."tasks"  ("status");
CREATE INDEX IF NOT EXISTS "IDX_5a0f95281dd3e440bbe3996dd8" ON "asgraph"."tasks"  ("attempt");
CREATE INDEX IF NOT EXISTS "IDX_93de7eb873f12aa17962a386fc" ON "asgraph"."tasks"  ("currentStep");
CREATE INDEX IF NOT EXISTS "IDX_10f8a3df60c9e7771cefba6c35" ON "asgraph"."tasks"  ("createdAt");
CREATE INDEX IF NOT EXISTS "IDX_955b728d4ffcea6f051a341946" ON "asgraph"."tasks"  ("updatedAt");
CREATE INDEX IF NOT EXISTS "IDX_97dd6125cba9c54b7c6cd02b08" ON "asgraph"."tasks"  ("createdBy");
CREATE INDEX IF NOT EXISTS "IDX_02f55e7a79d4203b3e3f67b2dd" ON "asgraph"."tasks"  ("updatedBy");
CREATE TABLE IF NOT EXISTS "asgraph"."task_event" ("id" character varying NOT NULL, "taskId" character varying, "ts" TIMESTAMP, "classification" character varying, "payload" character varying, CONSTRAINT "PK_5512953f207de074aea7e6b1515" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "IDX_5512953f207de074aea7e6b151" ON "asgraph"."task_event"  ("id");
CREATE INDEX IF NOT EXISTS "IDX_aac7a677233eb7637f19478803" ON "asgraph"."task_event"  ("taskId");
CREATE INDEX IF NOT EXISTS "IDX_4ad52fe9f3db35d1a51764eb61" ON "asgraph"."task_event"  ("ts");
CREATE INDEX IF NOT EXISTS "IDX_cb46b64547e8d6436ebc8d85ce" ON "asgraph"."task_event"  ("classification");

RESET search_path;
