/**
 * @module as-graph/tests/unit/graph/GraphAuthNamespaces
 * @summary SAA-2014: `@namespace(...)` folding + decomposed namespace
 * authorization contract tests.
 * @description Proves the shared `@namespace([...])` metadata path is folded into
 * the compiled manifests/documents and that {@link GraphAuthValidator} authorizes
 * the workflow AND every plan node against the decomposed granted namespaces/roles.
 *
 * The decorator is imported from its real package path
 * (`@decaf-ts/integrations/nest`) so a key rename (e.g. `auth-namespace`)
 * regresses here rather than only in the integrations package.
 */
import { describe, it, expect, jest } from "@jest/globals";

// `@decaf-ts/integrations/nest` transitively imports the crypto `JwtService`,
// which pulls the ESM-only `jose` package. These suites only exercise the
// `@namespace` metadata decorator, so the ESM `jose` module is stubbed for the
// CommonJS jest runtime.
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  decodeJwt: jest.fn(),
  SignJWT: class {},
}));

import { Model, model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { namespace } from "@decaf-ts/integrations/nest";
import { ForbiddenError } from "@decaf-ts/core";

import {
  graph,
  graphDecoratedWorkflowCompiler,
  graphNodeManifest,
  graphAuthMetadataOf,
  graphNamespacesOfModel,
  graphNamespacesOfMetadata,
  graphRolesOfMetadata,
  GRAPH_AUTH_METADATA_KEY,
  node,
  port,
  PortDirection,
} from "../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphNodeManifestResolver } from "../../../src/engine/catalog/GraphNodeManifestResolver";
import { GraphAuthValidator, graphAuthDataOf } from "../../../src/engine/auth";
import type { GraphAuthData, GraphNamespaceCacheEntry } from "../../../src/engine/auth";
import type { GraphExecutionPlan } from "../../../src/engine/planning/GraphExecutionPlan";
import type { GraphExecutionPlanNode } from "../../../src/engine/planning/GraphExecutionPlanNode";
import { minimalManifest } from "./engine-fixtures";

const NODE_NAMESPACES = ["acme.engineering.admin", "acme.platform.admin"];
const WORKFLOW_NAMESPACE = "acme.engineering.admin";

/** Node class carrying the real integrations `@namespace(...)` requirement. */
@node("auth.ns.node", { kind: "auth.ns.node", category: "Auth" })
@namespace(NODE_NAMESPACES)
@model()
class NamespacedNode extends Model {
  @uielement("input", { label: "Value" })
  @port(PortDirection.INPUT)
  value!: string;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

/** Node class without any namespace requirement (unrestricted). */
@node("auth.plain.node", { kind: "auth.plain.node", category: "Auth" })
@model()
class PlainNode extends Model {
  @uielement("input", { label: "Value" })
  @port(PortDirection.INPUT)
  value!: string;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

/** Workflow class carrying a workflow-level `@namespace(...)` requirement. */
@graph("auth-ns-workflow", {
  kind: "auth.ns.workflow",
  nodes: [
    { id: "n1", kind: "auth.plain.node", label: "Plain", node: PlainNode },
  ],
  relations: [
    { source: "workflow", sourcePort: "value", target: "n1", targetPort: "value" },
    { source: "n1", sourcePort: "result", target: "workflow", targetPort: "result" },
  ],
})
@namespace([WORKFLOW_NAMESPACE])
@model()
class NamespacedWorkflow extends Model {
  @required()
  @uielement("input", { label: "Value" })
  @port(PortDirection.INPUT)
  value!: string;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

/** Workflow without a workflow-level namespace requirement. */
@graph("auth-plain-workflow", {
  kind: "auth.plain.workflow",
  nodes: [
    { id: "n1", kind: "auth.plain.node", label: "Plain", node: PlainNode },
  ],
  relations: [
    { source: "workflow", sourcePort: "value", target: "n1", targetPort: "value" },
    { source: "n1", sourcePort: "result", target: "workflow", targetPort: "result" },
  ],
})
@model()
class PlainWorkflow extends Model {
  @uielement("input", { label: "Value" })
  @port(PortDirection.INPUT)
  value!: string;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

function documentWithAuth(
  id: string,
  auth: { namespaces?: string[]; roles?: string[] },
  nodes: GraphWorkflowDocument["nodes"] = [
    { id: "n1", kind: "auth.plain.node", parameters: {} },
  ]
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes,
    edges: [],
    metadata: { [GRAPH_AUTH_METADATA_KEY]: auth },
  };
}

/** Hand-builds a one-node plan for direct validator tests. */
function planFor(
  document: GraphWorkflowDocument,
  manifestNamespaces?: string[]
): GraphExecutionPlan {
  const node: GraphExecutionPlanNode = {
    instance: { id: "n1", kind: "auth.plain.node", parameters: {} },
    manifest: minimalManifest("auth.plain.node", ["value"], ["result"]),
    executor: { execute: () => ({}) },
  } as unknown as GraphExecutionPlanNode;
  if (manifestNamespaces) node.manifest.namespaces = manifestNamespaces;
  return {
    resolved: {} as never,
    workflowId: document.id,
    nodes: [node],
    edges: [],
    layers: [],
    incomingByNode: new Map(),
    outgoingByNode: new Map(),
  } as unknown as GraphExecutionPlan;
}

function validCacheEntry(namespace: string): GraphNamespaceCacheEntry {
  const [organization, department, role] = namespace.split(".");
  return {
    namespace,
    parts: {
      organization,
      departments: department.split(","),
      role,
    },
  };
}

describe("GraphAuthNamespaces (SAA-2014)", () => {
  describe("@namespace folding", () => {
    it("folds the real integrations @namespace(...) metadata into GraphNodeManifest.namespaces", () => {
      const manifest = graphNodeManifest(NamespacedNode);

      expect(manifest.kind).toBe("auth.ns.node");
      expect(manifest.namespaces).toEqual(NODE_NAMESPACES);
    });

    it("leaves GraphNodeManifest.namespaces unset for a node with no requirement", () => {
      const manifest = graphNodeManifest(PlainNode);

      expect(manifest.namespaces).toBeUndefined();
    });

    it("carries the requirement into the resolved GraphResolvedNodeManifest", async () => {
      const manifest = graphNodeManifest(NamespacedNode);
      const resolver = new GraphNodeManifestResolver();
      const resolved = await resolver.resolve(
        "auth.ns.node",
        manifest,
        undefined,
        { id: "n1", kind: "auth.ns.node", parameters: {} }
      );

      expect(resolved.namespaces).toEqual(NODE_NAMESPACES);
    });

    it("folds the real integrations @namespace(...) on a @graph class into metadata.auth.namespaces", () => {
      const document = graphDecoratedWorkflowCompiler(NamespacedWorkflow, {
        id: "auth-ns-doc",
      });

      expect(graphAuthMetadataOf(document.metadata)).toEqual({
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(graphNamespacesOfMetadata(document.metadata)).toEqual([
        WORKFLOW_NAMESPACE,
      ]);
      expect(document.metadata).toMatchObject({
        [GRAPH_AUTH_METADATA_KEY]: { namespaces: [WORKFLOW_NAMESPACE] },
      });
    });

    it("omits the metadata.auth bag for a workflow with no requirement", () => {
      const document = graphDecoratedWorkflowCompiler(PlainWorkflow, {
        id: "auth-plain-doc",
      });

      expect(graphAuthMetadataOf(document.metadata)).toBeUndefined();
      expect(graphNamespacesOfMetadata(document.metadata)).toEqual([]);
    });

    it("reads the namespace metadata directly from the decorated class", () => {
      expect(graphNamespacesOfModel(NamespacedNode)).toEqual(NODE_NAMESPACES);
      expect(graphNamespacesOfModel(PlainNode)).toEqual([]);
    });
  });

  describe("auth metadata normalization", () => {
    it("drops empty arrays and non-string entries", () => {
      expect(graphAuthMetadataOf(undefined)).toBeUndefined();
      expect(graphAuthMetadataOf({})).toBeUndefined();
      expect(
        graphAuthMetadataOf({ auth: { namespaces: [], roles: [] } })
      ).toBeUndefined();
      expect(
        graphAuthMetadataOf({
          auth: { namespaces: ["ok", 1, "", null] as never, roles: ["r"] },
        })
      ).toEqual({ namespaces: ["ok"], roles: ["r"] });
      expect(graphAuthMetadataOf({ auth: "not-an-object" })).toBeUndefined();
      expect(graphAuthMetadataOf({ auth: ["array"] })).toBeUndefined();
    });

    it("reads workflow roles from metadata.auth.roles", () => {
      expect(graphRolesOfMetadata({ auth: { roles: ["admin"] } })).toEqual([
        "admin",
      ]);
      expect(graphRolesOfMetadata({})).toEqual([]);
    });
  });

  describe("GraphAuthValidator — disabled by default", () => {
    const validator = new GraphAuthValidator();

    it("is disabled by default", () => {
      expect(validator.enabled).toBe(false);
    });

    it("no-ops an ungranted namespace requirement when disabled", () => {
      const document = documentWithAuth("disabled-ns", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        validator.validate(document, planFor(document), {})
      ).not.toThrow();
    });

    it("no-ops an ungranted role requirement when disabled", () => {
      const document = documentWithAuth("disabled-role", { roles: ["admin"] });
      expect(() =>
        validator.validate(document, planFor(document), { roles: ["viewer"] })
      ).not.toThrow();
    });

    it("honours an explicit `enabled: false`", () => {
      const disabled = new GraphAuthValidator({ enabled: false });
      const document = documentWithAuth("explicit-disabled", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        disabled.validate(document, planFor(document), {})
      ).not.toThrow();
    });
  });

  describe("GraphAuthValidator — enforcement (inherit mode default)", () => {
    const validator = new GraphAuthValidator({ enabled: true });

    it("allows an unrestricted workflow and node", () => {
      const document = documentWithAuth("plain", {});
      expect(() =>
        validator.validate(document, planFor(document), {})
      ).not.toThrow();
    });

    it("rejects a workflow missing a required namespace", () => {
      const document = documentWithAuth("wf-ns", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["acme.platform.admin"],
        })
      ).toThrow(ForbiddenError);
    });

    it("rejects a node missing a required namespace even when the workflow is granted", () => {
      const document = documentWithAuth("node-ns", {});
      expect(() =>
        validator.validate(
          document,
          planFor(document, [WORKFLOW_NAMESPACE]),
          { namespaces: ["acme.platform.admin"] }
        )
      ).toThrow(ForbiddenError);
    });

    it("rejects a workflow missing a required role", () => {
      const document = documentWithAuth("role-ns", { roles: ["admin"] });
      expect(() =>
        validator.validate(document, planFor(document), { roles: ["viewer"] })
      ).toThrow(ForbiddenError);
    });

    it("names the missing namespace in the failure message", () => {
      const document = documentWithAuth("wf-msg", {
        namespaces: ["acme.engineering.admin", "acme.platform.admin"],
      });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["acme.engineering.admin"],
        })
      ).toThrow(/acme\.platform\.admin/);
    });

    it("authorizes a fully granted workflow and node", () => {
      const document = documentWithAuth("wf-granted", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        validator.validate(
          document,
          planFor(document, ["acme.platform.admin"]),
          {
            namespaces: ["acme.engineering.admin", "acme.platform.admin"],
          }
        )
      ).not.toThrow();
    });

    it("does not satisfy a required role with a granted namespace whose role differs", () => {
      const document = documentWithAuth("role-not-ns", { roles: ["admin"] });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["acme.engineering.viewer"],
        })
      ).toThrow(ForbiddenError);
    });

    it("derives the granted role from the namespace and satisfies the requirement", () => {
      const document = documentWithAuth("role-derived", { roles: ["admin"] });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: [WORKFLOW_NAMESPACE],
        })
      ).not.toThrow();
    });

    it("ignores the standalone roles list for enforcement", () => {
      // Board ruling (interaction 142e945c): roles are DERIVED from namespaces,
      // so a standalone `roles` list grants nothing.
      const document = documentWithAuth("role-standalone", { roles: ["admin"] });
      expect(() =>
        validator.validate(document, planFor(document), { roles: ["admin"] })
      ).toThrow(ForbiddenError);
    });

    it("fails closed and logs a failed access attempt for malformed namespaces", () => {
      const logger = { warn: jest.fn() } as never;
      const document = documentWithAuth("malformed-required", {
        namespaces: ["team-a"],
      });
      expect(() =>
        validator.validate(
          document,
          planFor(document),
          { namespaces: ["team-a"] },
          logger
        )
      ).toThrow(ForbiddenError);
      expect(
        (logger as unknown as { warn: jest.Mock }).warn
      ).toHaveBeenCalledWith(expect.stringContaining("failed closed"));
    });

    it("fails closed for a malformed granted namespace", () => {
      const document = documentWithAuth("malformed-granted", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["team-a"],
        })
      ).toThrow(ForbiddenError);
    });
  });

  describe("GraphAuthValidator — inherit mode", () => {
    const validator = new GraphAuthValidator({
      enabled: true,
      match: { mode: "inherit" },
    });

    it("grants a broader department scope covering a narrower requirement", () => {
      const document = documentWithAuth("inherit-granted", {
        namespaces: ["acme.engineering,platform.admin"],
      });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: [WORKFLOW_NAMESPACE],
        })
      ).not.toThrow();
    });

    it("defaults to inherit mode and grants a broader department scope", () => {
      const byDefault = new GraphAuthValidator({ enabled: true });
      const document = documentWithAuth("inherit-default", {
        namespaces: ["acme.engineering,platform.admin"],
      });
      expect(() =>
        byDefault.validate(document, planFor(document), {
          namespaces: [WORKFLOW_NAMESPACE],
        })
      ).not.toThrow();
    });

    it("denies a broader grant when enforcement is in exact mode", () => {
      const exact = new GraphAuthValidator({
        enabled: true,
        match: { mode: "exact" },
      });
      const document = documentWithAuth("exact-denied", {
        namespaces: ["acme.engineering,platform.admin"],
      });
      expect(() =>
        exact.validate(document, planFor(document), {
          namespaces: [WORKFLOW_NAMESPACE],
        })
      ).toThrow(ForbiddenError);
    });
  });

  describe("GraphAuthValidator — namespaceCache", () => {
    const validator = new GraphAuthValidator({ enabled: true });

    it("authorizes from a valid cache entry", () => {
      const document = documentWithAuth("cache-valid", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      const auth: GraphAuthData = {
        namespaces: [WORKFLOW_NAMESPACE],
        namespaceCache: [validCacheEntry(WORKFLOW_NAMESPACE)],
      };
      expect(() =>
        validator.validate(document, planFor(document), auth)
      ).not.toThrow();
    });

    it("authorizes from an absent cache entry", () => {
      const document = documentWithAuth("cache-absent", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: [WORKFLOW_NAMESPACE],
        })
      ).not.toThrow();
    });

    it("does not let a forged cache entry grant a broader role", () => {
      const document = documentWithAuth("cache-forged", {
        namespaces: [WORKFLOW_NAMESPACE],
      });
      const forged: GraphNamespaceCacheEntry = {
        namespace: "acme.engineering.viewer",
        parts: {
          organization: "acme",
          departments: ["engineering"],
          role: "admin",
        },
      };
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["acme.engineering.viewer"],
          namespaceCache: [forged],
        })
      ).toThrow(ForbiddenError);
    });

    it("does not let a stale cache entry grant access to a different namespace", () => {
      const document = documentWithAuth("cache-stale", {
        namespaces: ["acme.platform.admin"],
      });
      const stale: GraphNamespaceCacheEntry = {
        namespace: "acme.engineering.admin",
        parts: {
          organization: "acme",
          departments: ["engineering"],
          role: "admin",
        },
      };
      expect(() =>
        validator.validate(document, planFor(document), {
          namespaces: ["acme.engineering.admin"],
          namespaceCache: [stale],
        })
      ).toThrow(ForbiddenError);
    });
  });

  describe("graphAuthDataOf", () => {
    it("returns the empty fallback for a missing context", () => {
      expect(graphAuthDataOf(null)).toEqual({});
      expect(graphAuthDataOf(undefined)).toEqual({});
    });
  });
});
