/**
 * @module as-graph/tests/unit/graph/GraphExecutionAuth.test
 * @summary Engine-level authorization and run-log binding tests (SAA-2014).
 * @description Proves the engine is auth-optional by default (enforcement only
 * when `authEnabled` is set), authorizes the full workflow AND every planned node
 * against the decomposed granted namespaces before any node executes, and binds the
 * principal's app parameters onto the run-scoped `ctx.logger` so every
 * `GRAPH_RUN_LOG` entry carries them.
 */
import { describe, it, expect } from "@jest/globals";
import { Context, ForbiddenError } from "@decaf-ts/core";

import { GraphExecutionEventType } from "../../../src/shared/graph";
import type {
  GraphExecutionEvent,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type { GraphExecutionEngineConfig } from "../../../src/engine/execution/GraphExecutionEngine";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "./engine-fixtures";

const WORKFLOW_NAMESPACE = "acme.engineering.admin";
const BROADER_GRANT = "acme.engineering.admin";
const NARROWER_REQUIREMENT = "acme.engineering,platform.admin";

interface ProbeCatalogue {
  registry: GraphNodeExecutorRegistry;
  counts: Record<string, number>;
}

async function probeCatalogue(
  kinds: { kind: string; namespaces?: string[] }[]
): Promise<ProbeCatalogue> {
  const catalogue = freshCatalogue();
  const counts: Record<string, number> = {};
  for (const { kind, namespaces } of kinds) {
    counts[kind] = 0;
    await catalogue.register(
      defineGraphNode({
        manifest: {
          kind,
          display: { name: kind },
          inputs: [{ id: "value", label: "value", direction: "input" }],
          outputs: [{ id: "result", label: "result", direction: "output" }],
          parameters: [],
          ...(namespaces ? { namespaces } : {}),
        },
        executor: {
          execute: (_request, context) => {
            counts[kind] += 1;
            context.logger.info(`${kind} ran`);
            return { result: kind };
          },
        },
      })
    );
  }
  return { registry: new GraphNodeExecutorRegistry(catalogue), counts };
}

function authDocument(
  id: string,
  kind: string,
  auth?: { namespaces?: string[]; roles?: string[] }
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [documentNode("probe", kind)],
    edges: [
      documentEdge("e0", ["workflow", "value"], ["node", "probe", "value"]),
      documentEdge("e1", ["node", "probe", "result"], ["workflow", "result"]),
    ],
    ...(auth ? { metadata: { auth } } : {}),
  };
}

async function buildEngine(
  kinds: { kind: string; namespaces?: string[] }[],
  config: Partial<GraphExecutionEngineConfig> = {}
): Promise<{
  engine: GraphExecutionEngine;
  counts: Record<string, number>;
  events: GraphExecutionEvent[];
}> {
  const { registry, counts } = await probeCatalogue(kinds);
  const events: GraphExecutionEvent[] = [];
  const engine = await bootEngine({ registry, ...config });
  engine.observe({
    refresh: async (event) => {
      events.push(event);
    },
  });
  return { engine, counts, events };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("GraphExecutionEngine authorization (SAA-2014)", () => {
  describe("no-auth mode (disabled by default)", () => {
    it("runs a namespace-guarded workflow without a context or namespaces", async () => {
      const { engine, counts } = await buildEngine([{ kind: "auth.probe" }]);
      const document = authDocument("no-auth", "auth.probe", {
        namespaces: [WORKFLOW_NAMESPACE],
      });

      const result = await engine.execute(document, { value: 1 });

      expect(result.status).toBe("succeeded");
      expect(counts["auth.probe"]).toBe(1);
    });

    it("runs a node requiring a namespace without a context or namespaces", async () => {
      const { engine, counts } = await buildEngine([
        { kind: "auth.ns.probe", namespaces: [WORKFLOW_NAMESPACE] },
      ]);

      const result = await engine.execute(
        authDocument("no-auth-node", "auth.ns.probe"),
        { value: 1 }
      );

      expect(result.status).toBe("succeeded");
      expect(counts["auth.ns.probe"]).toBe(1);
    });
  });

  describe("enforcement when authEnabled", () => {
    it("rejects a workflow whose required namespace is not granted and runs no node", async () => {
      const { engine, counts, events } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const document = authDocument("ns-guarded", "auth.probe", {
        namespaces: [WORKFLOW_NAMESPACE],
      });

      await expect(
        engine.execute(document, { value: 1 })
      ).rejects.toThrow(ForbiddenError);

      expect(counts["auth.probe"]).toBe(0);
      expect(
        events.some((e) => e.type === GraphExecutionEventType.NODE_STARTED)
      ).toBe(false);
    });

    it("executes when the required workflow namespace is granted", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const document = authDocument("ns-granted", "auth.probe", {
        namespaces: [WORKFLOW_NAMESPACE],
      });

      const result = await engine.execute(document, { value: 1 }, {
        auth: { namespaces: [WORKFLOW_NAMESPACE] },
      });

      expect(result.status).toBe("succeeded");
      expect(counts["auth.probe"]).toBe(1);
    });

    it("grants a narrower requirement from a broader department grant in inherit mode", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true, authMatch: { mode: "inherit" } }
      );
      const document = authDocument("ns-inherit", "auth.probe", {
        namespaces: [NARROWER_REQUIREMENT],
      });

      const result = await engine.execute(document, { value: 1 }, {
        auth: { namespaces: [BROADER_GRANT] },
      });

      expect(result.status).toBe("succeeded");
      expect(counts["auth.probe"]).toBe(1);
    });

    it("rejects a narrower requirement from a broader grant in exact mode", async () => {
      const { engine } = await buildEngine([{ kind: "auth.probe" }], {
        authEnabled: true,
        authMatch: { mode: "exact" },
      });
      const document = authDocument("ns-exact", "auth.probe", {
        namespaces: [NARROWER_REQUIREMENT],
      });

      await expect(
        engine.execute(document, { value: 1 }, {
          auth: { namespaces: [BROADER_GRANT] },
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects a workflow whose required role is not derived from a granted namespace", async () => {
      const { engine } = await buildEngine([{ kind: "auth.probe" }], {
        authEnabled: true,
      });
      const document = authDocument("role-guarded", "auth.probe", {
        roles: ["admin"],
      });

      await expect(
        engine.execute(document, { value: 1 })
      ).rejects.toThrow(ForbiddenError);
    });

    it("executes when the required role is the role component of a granted namespace", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const document = authDocument("role-derived", "auth.probe", {
        roles: ["admin"],
      });

      const result = await engine.execute(document, { value: 1 }, {
        auth: { namespaces: [WORKFLOW_NAMESPACE] },
      });

      expect(result.status).toBe("succeeded");
      expect(counts["auth.probe"]).toBe(1);
    });

    it("rejects a malformed required namespace and runs no node", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const document = authDocument("malformed", "auth.probe", {
        namespaces: ["team-a"],
      });

      await expect(
        engine.execute(document, { value: 1 }, {
          auth: { namespaces: ["team-a"] },
        })
      ).rejects.toThrow(ForbiddenError);

      expect(counts["auth.probe"]).toBe(0);
    });
  });

  describe("node-level requirement", () => {
    it("rejects a workflow whose node requires an ungranted namespace and runs no node", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.ns.probe", namespaces: [WORKFLOW_NAMESPACE] }],
        { authEnabled: true }
      );

      await expect(
        engine.execute(authDocument("node-guarded", "auth.ns.probe"), {
          value: 1,
        })
      ).rejects.toThrow(ForbiddenError);

      expect(counts["auth.ns.probe"]).toBe(0);
    });

    it("executes when the required node namespace is granted", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.ns.probe", namespaces: [WORKFLOW_NAMESPACE] }],
        { authEnabled: true }
      );

      const result = await engine.execute(
        authDocument("node-granted", "auth.ns.probe"),
        { value: 1 },
        { auth: { namespaces: [WORKFLOW_NAMESPACE] } }
      );

      expect(result.status).toBe("succeeded");
      expect(counts["auth.ns.probe"]).toBe(1);
    });
  });

  describe("principal sources", () => {
    it("reads the authenticated principal from the Decaf execution context", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const context = new Context().accumulate({
        operation: "execute",
        user: "alice",
        namespaces: [WORKFLOW_NAMESPACE],
      });
      const document = authDocument("ctx-principal", "auth.probe", {
        namespaces: [WORKFLOW_NAMESPACE],
      });

      const result = await engine.execute(document, { value: 1 }, {}, context);

      expect(result.status).toBe("succeeded");
      expect(counts["auth.probe"]).toBe(1);
    });

    it("lets the explicit option override the context principal", async () => {
      const { engine, counts } = await buildEngine(
        [{ kind: "auth.probe" }],
        { authEnabled: true }
      );
      const context = new Context().accumulate({
        operation: "execute",
        user: "alice",
        namespaces: [WORKFLOW_NAMESPACE],
      });
      const document = authDocument("ctx-override", "auth.probe", {
        namespaces: [WORKFLOW_NAMESPACE],
      });

      await expect(
        engine.execute(document, { value: 1 }, { auth: { namespaces: [] } }, context)
      ).rejects.toThrow(ForbiddenError);

      expect(counts["auth.probe"]).toBe(0);
    });
  });

  describe("run log binding", () => {
    it("binds user/roles/namespaces/organization/ip onto GRAPH_RUN_LOG entries", async () => {
      const { engine, events } = await buildEngine([{ kind: "auth.probe" }]);

      const result = await engine.execute(
        authDocument("log-binding", "auth.probe"),
        { value: 1 },
        {
          auth: {
            user: "alice",
            roles: ["admin"],
            namespaces: [WORKFLOW_NAMESPACE],
            organization: "acme",
            ip: "10.0.0.7",
          },
        }
      );
      await flush();

      expect(result.status).toBe("succeeded");
      const entry = events.find(
        (event) => event.type === GraphExecutionEventType.GRAPH_RUN_LOG
      )?.payload as Record<string, unknown> | undefined;
      expect(entry).toBeDefined();
      expect(entry?.nodeId).toBe("probe");
      expect(entry?.user).toBe("alice");
      expect(entry?.roles).toEqual(["admin"]);
      expect(entry?.namespaces).toEqual([WORKFLOW_NAMESPACE]);
      expect(entry?.organization).toBe("acme");
      expect(entry?.ip).toBe("10.0.0.7");
    });
  });
});
