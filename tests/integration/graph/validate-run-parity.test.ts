/**
 * @module as-graph/tests/integration/graph/validate-run-parity
 * @summary SAA-1357 D2 regression: `POST /graph/workflows/validate` and the
 * run path (`GraphExecutionEngine.execute`) must agree.
 * @description Boots the real `GraphExecutionModule` (built-in catalogue, the
 * isolated-vm code sandbox evaluator, and the engine wired into
 * `GraphWorkflowController`) over HTTP. Asserts that:
 * - the served `fixture-schedule-code` document validates with `{valid:true,
 *   issues:[]}` (and the response never leaks `resolved`) and then executes
 *   successfully through the engine;
 * - the same document with a non-string `code` literal binding is rejected by
 *   the validate endpoint and by the run path with the same
 *   `binding.literal-invalid` issue at `nodes[compute].inputBindings.code`;
 * - all 12 registered fixture documents pass the engine's nine-stage
 *   `GraphWorkflowDocumentValidator`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Context } from "@decaf-ts/core";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEngine, registerBuiltInGraphNodes } from "../../../src";
import { GraphWorkflowDocumentValidator } from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import { GraphDocumentValidationError } from "../../../src/engine/validation/GraphValidationErrors";
import {
  graphWorkflowFixtures,
  graphWorkflowFixturesById,
} from "../../../src/workflows";
import { createGraphRunTestApp } from "../../unit/nest/graphRunTestSupport";
import { freshCatalogue } from "../../unit/graph/engine-fixtures";

jest.setTimeout(180000);

const INVALID_LITERAL_ISSUE = {
  code: "binding.literal-invalid",
  path: "nodes[compute].inputBindings.code",
  nodeId: "compute",
};

/** Deep-clones the served fixture document so mutations stay local. */
function cloneDocument(document: GraphWorkflowDocument): GraphWorkflowDocument {
  return JSON.parse(JSON.stringify(document)) as GraphWorkflowDocument;
}

/** Returns the `compute` node of the schedule-code fixture. */
function computeNode(document: GraphWorkflowDocument) {
  const node = document.nodes.find((candidate) => candidate.id === "compute");
  if (!node) throw new Error("fixture node 'compute' is missing");
  return node;
}

describe("validate/run parity (SAA-1357 D2)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let engine: GraphExecutionEngine;
  let fixture: (typeof graphWorkflowFixtures)[number];

  beforeAll(async () => {
    ({ app, moduleRef } = await createGraphRunTestApp());
    engine = moduleRef.get(GraphExecutionEngine);
    fixture = graphWorkflowFixturesById["fixture-schedule-code"];
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());
  const validate = (document: GraphWorkflowDocument) =>
    api().post("/graph/workflows/validate").send(document);

  it("accepts the served fixture document and never returns `resolved`", async () => {
    const res = await validate(fixture.document);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ valid: true, issues: [] });
    expect(res.body).not.toHaveProperty("resolved");
  });

  it("executes the same served fixture document through the run path", async () => {
    const result = await engine.execute(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toMatchObject(fixture.expectedOutputs ?? {});
  });

  it("rejects a non-string code literal in the validate endpoint with the structured issue", async () => {
    const invalid = cloneDocument(fixture.document);
    (computeNode(invalid).inputBindings as Record<string, unknown>)["code"] = {
      mode: "literal",
      value: 123,
    };

    const res = await validate(invalid);
    expect(res.status).toBe(201);
    expect(res.body.valid).toBe(false);
    expect(res.body).not.toHaveProperty("resolved");
    expect(
      res.body.issues.find(
        (issue: { code?: string }) => issue.code === INVALID_LITERAL_ISSUE.code
      )
    ).toMatchObject(INVALID_LITERAL_ISSUE);
  });

  it("rejects the same document through the run path with the same issue code/path/nodeId", async () => {
    const invalid = cloneDocument(fixture.document);
    (computeNode(invalid).inputBindings as Record<string, unknown>)["code"] = {
      mode: "literal",
      value: 123,
    };

    let error: unknown;
    try {
      await engine.execute(invalid, fixture.inputs ?? {});
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(GraphDocumentValidationError);
    const issues = (error as GraphDocumentValidationError).issues;
    expect(
      issues.find((issue) => issue.code === INVALID_LITERAL_ISSUE.code)
    ).toMatchObject(INVALID_LITERAL_ISSUE);
  });

  it("passes all 12 fixture documents through the nine-stage validator", async () => {
    const catalogue = freshCatalogue();
    await registerBuiltInGraphNodes(catalogue);
    const validator = new GraphWorkflowDocumentValidator({ catalogue });
    expect(graphWorkflowFixtures).toHaveLength(12);

    for (const registered of graphWorkflowFixtures) {
      const result = await validator.validate(
        registered.document,
        0,
        new Context()
      );
      expect({
        id: registered.id,
        valid: result.valid,
        issues: result.issues,
      }).toEqual({ id: registered.id, valid: true, issues: [] });
    }
  });
});
