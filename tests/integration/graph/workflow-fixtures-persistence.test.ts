/**
 * @module as-graph/tests/integration/graph/workflow-fixtures-persistence
 * @summary SAA-2049 evidence: the demo workflow fixture set is persisted
 * through the RAM adapter (not only held in memory) and reloads deep-equal,
 * including `GraphValueTemplate` parameter objects, and a fresh
 * `GraphWorkflowService` over the same adapter sees the persisted workflows.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { Context, PersistenceService } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import { Injectables } from "@decaf-ts/injectable-decorators";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import {
  LEVEL_EXPRESSION_TEMPLATE,
  MESSAGE_TEMPLATE,
  graphWorkflowFixtures,
  type GraphWorkflowFixture,
} from "../../fixtures/workflows";
import { resolveGraphValueTemplate } from "../../../src/shared/graph";

RamAdapter.decoration();

/**
 * Clears the injectable cache entry for `GraphWorkflowService` so a genuinely
 * fresh service instance is constructed over the same adapter.
 */
function resetWorkflowServiceInjectable(): void {
  const registry = Injectables.getRegistry() as unknown as {
    cache?: Record<string | symbol, { instance?: unknown }>;
  };
  const cache = registry.cache;
  if (!cache) return;
  for (const key of Object.getOwnPropertySymbols(cache)) {
    const entry = cache[key];
    if (entry && typeof entry === "object") entry.instance = undefined;
  }
}

function anonymous(): Context {
  return new Context();
}

function expectRoundTrip(fixture: GraphWorkflowFixture): void {
  expect(fixture.document.id).toBe(fixture.id);
}

describe("demo workflow fixtures — adapter persistence (SAA-2049)", () => {
  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
  });

  it("saves every fixture and reloads it deep-equal through the adapter", async () => {
    const service = new GraphWorkflowService();
    const ctx = anonymous();
    for (const fixture of graphWorkflowFixtures) {
      expectRoundTrip(fixture);
      const saved = await service.saveDocument(
        fixture.document.id,
        fixture.document,
        ctx
      );
      expect(saved.workflowId).toBe(fixture.document.id);
      const loaded = await service.getDocument(fixture.document.id, ctx);
      expect(loaded).toEqual(fixture.document);
    }
  });

  it("persists GraphValueTemplate user properties verbatim", async () => {
    const service = new GraphWorkflowService();
    const ctx = anonymous();
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-value-templates"
    );
    expect(fixture).toBeDefined();
    await service.saveDocument(fixture!.document.id, fixture!.document, ctx);
    const loaded = await service.getDocument(fixture!.document.id, ctx);
    expect(loaded).toEqual(fixture!.document);
    const expression = loaded.nodes.find(
      (node) => node.id === "expressionLog"
    )?.parameters["level"];
    const template = loaded.nodes.find(
      (node) => node.id === "templateLog"
    )?.parameters["message"];
    expect(expression).toEqual(LEVEL_EXPRESSION_TEMPLATE);
    expect(template).toEqual(MESSAGE_TEMPLATE);
  });

  it("reloads through a fresh service instance over the same adapter", async () => {
    const first = new GraphWorkflowService();
    const ctx = anonymous();
    await first.saveDocument(
      "fixture-manual-log",
      graphWorkflowFixtures[0].document,
      ctx
    );

    resetWorkflowServiceInjectable();
    const fresh = new GraphWorkflowService();
    expect(fresh).not.toBe(first);
    const reloaded = await fresh.getDocument("fixture-manual-log", ctx);
    expect(reloaded).toEqual(graphWorkflowFixtures[0].document);
  });

  it("resolves the persisted GraphValueTemplate user properties via resolveGraphValueTemplate", async () => {
    const service = new GraphWorkflowService();
    const ctx = anonymous();
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-value-templates"
    )!;
    await service.saveDocument(fixture.document.id, fixture.document, ctx);
    const loaded = await service.getDocument(fixture.document.id, ctx);

    const expression = loaded.nodes.find(
      (node) => node.id === "expressionLog"
    )!.parameters["level"];
    const template = loaded.nodes.find(
      (node) => node.id === "templateLog"
    )!.parameters["message"];

    const calls: string[] = [];
    const evaluate = (value: string, language: string) => {
      calls.push(`${language}:${value}`);
      return "resolved";
    };
    expect(resolveGraphValueTemplate(expression, evaluate)).toBe("resolved");
    expect(resolveGraphValueTemplate(template, evaluate)).toBe("resolved");
    expect(calls).toEqual([
      `javascript:${LEVEL_EXPRESSION_TEMPLATE.expression}`,
      `text:${MESSAGE_TEMPLATE.expression}`,
    ]);
  });
});
