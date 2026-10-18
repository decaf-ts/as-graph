/**
 * @module as-graph/tests/integration/graph/workflowCatalogueReadAuth
 * @summary C8 regression coverage for SAA-958: catalogue reads through
 * `engine.getWorkflow` apply the document's workflow-level namespace
 * requirements when graph auth is enabled, and stay permissive when it is
 * disabled.
 * @description Persists a namespace-scoped workflow through the real
 * `GraphWorkflowService` (RAM adapter) and reads it back through the engine's
 * local backend. An owner carrying an ungranted namespace fails closed with
 * `ForbiddenError`; the owner carrying the granted namespace succeeds; with
 * auth disabled the namespace requirement is not enforced.
 */
import { beforeAll, describe, it, expect } from "@jest/globals";
import { Context, ForbiddenError, PersistenceService } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "../../unit/graph/engine-fixtures";

RamAdapter.decoration();

const REQUIRED_NAMESPACE = "acme.sales.reader";
const OTHER_NAMESPACE = "acme.support.reader";

function userContext(user: string, namespaces: string[] = []): Context {
  const ctx = new Context();
  return ctx.accumulate({
    user,
    namespaces,
    timestamp: new Date(),
  } as object) as Context;
}

function scopedDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [documentPort("brief")],
    outputs: [documentPort("summary")],
    nodes: [documentNode("n1", "core.transform", { value: "start" })],
    edges: [
      documentEdge("re0", ["workflow", "brief"], ["node", "n1", "value"]),
      documentEdge("re1", ["node", "n1", "out"], ["workflow", "summary"]),
    ],
    metadata: { auth: { namespaces: [REQUIRED_NAMESPACE] } },
  };
}

async function bootWith(service: GraphWorkflowService, authEnabled: boolean) {
  return await bootEngine({
    registry: new GraphNodeExecutorRegistry(freshCatalogue()),
    workflowStore: service,
    authEnabled,
  });
}

describe("engine.getWorkflow catalogue read mediation (C8)", () => {
  let service: GraphWorkflowService;
  let document: GraphWorkflowDocument;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
    service = new GraphWorkflowService();
    document = scopedDocument("c8-namespace-scoped");
    await service.saveDocument(
      document.id,
      document,
      userContext("alice", [REQUIRED_NAMESPACE])
    );
  });

  it("fails closed for an owner whose namespace grant is missing (auth enabled)", async () => {
    const engine = await bootWith(service, true);

    await expect(
      engine.getWorkflow(
        document.id,
        userContext("alice", [OTHER_NAMESPACE])
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("serves the document to its owner with the granted namespace (auth enabled)", async () => {
    const engine = await bootWith(service, true);

    await expect(
      engine.getWorkflow(
        document.id,
        userContext("alice", [REQUIRED_NAMESPACE])
      )
    ).resolves.toEqual(document);
  });

  it("does not enforce the namespace requirement when auth is disabled", async () => {
    const engine = await bootWith(service, false);

    await expect(
      engine.getWorkflow(
        document.id,
        userContext("alice", [OTHER_NAMESPACE])
      )
    ).resolves.toEqual(document);
  });
});
