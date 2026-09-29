/**
 * Migration of `ui-decorators/tests/unit/graph.test.ts` (SAA-1941, QA gate gap
 * from SAA-1936) onto the as-graph shared graph surface. Covers the top-level
 * graph decorators and readers that the SAA-1929 subdirectory migration did not:
 * node/workflow metadata composition, port derivation, composite/leaf port trees,
 * Schema-flattening `@input`/`@output` (`portGroups`), the `Metadata.nodes()` /
 * `Metadata.workflows()` registry accessors and `renderAsNode`.
 *
 * Import rewrites only: `../../src/graph` -> `../../../src/shared/graph`,
 * ui-decorators runtime imports -> `@decaf-ts/ui-decorators`, and the reproduced
 * `UIKeys` constant -> `../../../src/shared/ui/constants`.
 */
import "../../../src/shared/graph";
import { Metadata } from "@decaf-ts/decoration";
import { Model, model, required } from "@decaf-ts/decorator-validation";
import { RenderingEngine as UiRenderingEngine, uielement } from "@decaf-ts/ui-decorators";
import {
  graph,
  graphLeafPortsOf,
  graphPortsOf,
  graphWorkflowDefinitionOf,
  input,
  node,
  output,
  port,
  graphDefinitionOf,
  graphPortDefinitionOf,
} from "../../../src/shared/graph";
import { GraphKeys, PortDirection } from "../../../src/shared/graph";
import { UIKeys } from "../../../src/shared/ui/constants";

@node("graph-tool", {
  kind: "tool",
  category: "AI",
  icon: "tool",
  color: "#2196f3",
})
@model()
class GraphToolModel extends Model {
  @required()
  @uielement("input", { label: "Prompt" })
  @port(PortDirection.INPUT, { handle: "prompt" })
  prompt!: string;

  @uielement("textarea", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

@graph("graph-workflow", {
  kind: "workflow",
  category: "Workflow",
  nodes: [
    {
      id: "draft",
      kind: "node",
      label: "Draft node",
      node: "GraphDraftNode",
    },
    {
      id: "review",
      kind: "node",
      label: "Review node",
      node: "GraphReviewNode",
    },
  ],
  relations: [
    {
      source: "workflow",
      sourcePort: "brief",
      target: "draft",
      targetPort: "plan",
      label: "brief-to-plan",
    },
    {
      source: "draft",
      sourcePort: "draft",
      target: "review",
      targetPort: "draft",
      label: "draft-to-review",
    },
  ],
})
@model()
class GraphWorkflowModel extends Model {
  @required()
  @uielement("input", { label: "Brief" })
  @port(PortDirection.INPUT)
  brief!: string;

  @required()
  @uielement("input", { label: "Approved" })
  @port(PortDirection.OUTPUT)
  approved!: string;
}

@node("graph-address", {
  kind: "node",
  category: "AI",
})
@model()
class GraphAddressModel extends Model {
  @required()
  @uielement("input", { label: "Street" })
  @port(PortDirection.INPUT)
  street!: string;

  @required()
  @uielement("input", { label: "City" })
  @port(PortDirection.INPUT)
  city!: string;
}

@node("graph-company", {
  kind: "node",
  category: "AI",
})
@model()
class GraphCompanyModel extends Model {
  @required()
  @uielement("input", { label: "Name" })
  @port(PortDirection.INPUT)
  name!: string;

  @required()
  @uielement("input", { label: "Address" })
  @port(PortDirection.INPUT)
  address!: GraphAddressModel;
}

// --- Schema-flattening (@input / @output on a Schema-typed property) ---------

@model()
class IfInputSchema extends Model {
  @uielement("input", { label: "Input" })
  @input()
  input!: unknown;
}

@model()
class IfOutputSchema extends Model {
  @uielement("input", { label: "Then" })
  @output({ metadata: { branch: "then" } })
  then!: unknown;

  @uielement("input", { label: "Otherwise" })
  @output({ metadata: { branch: "else" } })
  otherwise!: unknown;
}

@node("core.flow.if", {
  kind: "core.flow.if",
  category: "Flow Control",
  icon: "split",
  portGroups: [
    { property: "inputSchema", toggle: "all" },
    { property: "outputSchema", toggle: "single", label: "Branches" },
  ],
})
@model()
class IfNode extends Model {
  @input()
  inputSchema!: IfInputSchema;

  @output()
  outputSchema!: IfOutputSchema;
}

// A Schema-typed @input / @output with NO declared portGroups — defaults to
// toggle: "all" for every group.
@node("core.flow.code", { kind: "core.flow.code", category: "Code", icon: "code" })
@model()
class CodeNode extends Model {
  @input()
  inputSchema!: IfInputSchema;

  @output()
  outputSchema!: IfInputSchema;
}

class GraphRenderer extends UiRenderingEngine<void, unknown> {
  constructor() {
    super("graph");
  }

  async initialize(): Promise<void> {
    return;
  }
}

describe("as-graph shared graph layer", () => {
  it("composes node metadata with uimodel metadata", () => {
    const uiModel = Metadata.get(
      GraphToolModel,
      Metadata.key(UIKeys.REFLECT, UIKeys.UIMODEL)
    );
    const graph = Metadata.get(GraphToolModel, GraphKeys.NODE);

    expect(uiModel).toEqual({
      tag: "graph-tool",
      props: undefined,
    });
    expect(graph).toEqual({
      kind: "tool",
      category: "AI",
      icon: "tool",
      color: "#2196f3",
    });
  });

  it("derives port metadata from the existing property metadata", () => {
    const promptPort = graphPortDefinitionOf(GraphToolModel, "prompt");

    expect(promptPort).toMatchObject({
      property: "prompt",
      direction: PortDirection.INPUT,
      label: "Prompt",
      required: true,
      hidden: false,
      graph: {
        direction: PortDirection.INPUT,
        handle: "prompt",
      },
    });
    expect(promptPort?.type).toBe("string");
    expect(promptPort?.designType).toBe("String");
  });

  it("expands nested model ports into a composite port tree", () => {
    const addressPort = graphPortDefinitionOf(GraphCompanyModel, "address");
    const definition = graphDefinitionOf(GraphCompanyModel);
    const leafPorts = graphLeafPortsOf(definition.ports);

    expect(addressPort).toMatchObject({
      property: "address",
      path: "address",
      composite: true,
      children: [
        expect.objectContaining({
          property: "street",
          path: "address.street",
        }),
        expect.objectContaining({
          property: "city",
          path: "address.city",
        }),
      ],
    });
    expect(leafPorts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "name",
          path: "name",
        }),
        expect.objectContaining({
          property: "street",
          path: "address.street",
        }),
        expect.objectContaining({
          property: "city",
          path: "address.city",
        }),
      ])
    );
  });

  it("builds a framework-neutral graph definition", () => {
    const definition = graphDefinitionOf(GraphToolModel);

    expect(definition).toMatchObject({
      name: "GraphToolModel",
      tag: "graph-tool",
      kind: "tool",
      category: "AI",
      icon: "tool",
      color: "#2196f3",
      ports: [
        expect.objectContaining({
          property: "prompt",
          direction: PortDirection.INPUT,
        }),
        expect.objectContaining({
          property: "result",
          direction: PortDirection.OUTPUT,
        }),
      ],
    });
  });

  it("decorates a workflow root with graph metadata and derived inputs/outputs", () => {
    const workflowMeta = Metadata.get(GraphWorkflowModel, GraphKeys.GRAPH);
    const workflowUi = Metadata.get(
      GraphWorkflowModel,
      Metadata.key(UIKeys.REFLECT, UIKeys.UIMODEL)
    );
    const definition = graphWorkflowDefinitionOf(GraphWorkflowModel);

    expect(workflowUi).toEqual({
      tag: "graph-workflow",
      props: undefined,
    });
    expect(workflowMeta).toMatchObject({
      kind: "workflow",
      category: "Workflow",
      inputs: [
        expect.objectContaining({
          property: "brief",
          direction: PortDirection.INPUT,
        }),
      ],
      outputs: [
        expect.objectContaining({
          property: "approved",
          direction: PortDirection.OUTPUT,
        }),
      ],
      nodes: [
        expect.objectContaining({
          id: "draft",
          label: "Draft node",
        }),
        expect.objectContaining({
          id: "review",
          label: "Review node",
        }),
      ],
      relations: [
        expect.objectContaining({
          source: "workflow",
          target: "draft",
        }),
        expect.objectContaining({
          source: "draft",
          target: "review",
        }),
      ],
    });
    expect(definition).toMatchObject({
      name: "GraphWorkflowModel",
      tag: "graph-workflow",
      kind: "workflow",
      category: "Workflow",
      inputs: [
        expect.objectContaining({
          property: "brief",
          direction: PortDirection.INPUT,
        }),
      ],
      outputs: [
        expect.objectContaining({
          property: "approved",
          direction: PortDirection.OUTPUT,
        }),
      ],
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: "draft",
        }),
        expect.objectContaining({
          id: "review",
        }),
      ]),
      relations: expect.arrayContaining([
        expect.objectContaining({
          label: "brief-to-plan",
        }),
      ]),
    });
  });

  it("exposes renderAsNode as a graph definition reader", () => {
    const engine = new GraphRenderer() as any;
    const rendered = engine.renderAsNode(
      new GraphToolModel(),
      {}
    ) as ReturnType<typeof graphDefinitionOf>;

    expect(rendered.tag).toBe("graph-tool");
    expect(rendered.ports).toHaveLength(2);
  });

  describe("schema-flattening @input / @output", () => {
    it("flattens a Schema-typed @input / @output into unprefixed ports", () => {
      const ports = graphPortsOf(IfNode);
      const properties = ports.map((p) => p.property);

      // The carrier properties (inputSchema / outputSchema) are NOT ports.
      expect(properties).not.toContain("inputSchema");
      expect(properties).not.toContain("outputSchema");

      // The Schema's matching-direction properties ARE ports, unprefixed.
      expect(properties).toEqual(["input", "then", "otherwise"]);

      const inputPort = ports.find((p) => p.property === "input");
      expect(inputPort).toMatchObject({
        property: "input",
        path: "input",
        direction: PortDirection.INPUT,
        label: "Input",
      });

      const thenPort = ports.find((p) => p.property === "then");
      expect(thenPort).toMatchObject({
        property: "then",
        path: "then",
        direction: PortDirection.OUTPUT,
        label: "Then",
        graph: { direction: PortDirection.OUTPUT, schema: true, metadata: { branch: "then" } },
      });

      const otherwisePort = ports.find((p) => p.property === "otherwise");
      expect(otherwisePort).toMatchObject({
        property: "otherwise",
        direction: PortDirection.OUTPUT,
        graph: { metadata: { branch: "else" } },
      });
    });

    it("returns undefined for the Schema group carrier from the singular reader", () => {
      expect(graphPortDefinitionOf(IfNode, "inputSchema")).toBeUndefined();
      expect(graphPortDefinitionOf(IfNode, "outputSchema")).toBeUndefined();
    });

    it("exposes the one-vs-all portGroups on the node definition", () => {
      const def = graphDefinitionOf(IfNode);
      expect(def.portGroups).toEqual([
        { property: "inputSchema", toggle: "all" },
        { property: "outputSchema", toggle: "single", label: "Branches" },
      ]);
    });

    it("defaults unlisted Schema groups to toggle: 'all'", () => {
      const def = graphDefinitionOf(CodeNode);
      expect(def.portGroups).toEqual([
        { property: "inputSchema", toggle: "all" },
        { property: "outputSchema", toggle: "all" },
      ]);
    });

    it("keeps @port (non-schema) Schema-typed properties as composite (legacy)", () => {
      // GraphCompanyModel.address uses @port, not @input — must stay composite.
      const addressPort = graphPortDefinitionOf(GraphCompanyModel, "address");
      expect(addressPort?.composite).toBe(true);
      expect(addressPort?.children?.map((c) => c.path)).toEqual([
        "address.street",
        "address.city",
      ]);
    });

    it("does not flatten a primitive @input / @output property", () => {
      // A primitive @input is a normal leaf port; `schema: true` is a no-op.
      @node("prim-node", { kind: "prim", category: "AI" })
      @model()
      class PrimNode extends Model {
        @uielement("input", { label: "Value" })
        @input()
        value!: string;
      }
      const ports = graphPortsOf(PrimNode);
      expect(ports.map((p) => p.property)).toEqual(["value"]);
      expect(ports[0]).toMatchObject({
        property: "value",
        direction: PortDirection.INPUT,
        label: "Value",
      });
    });
  });

  describe("Metadata.nodes() and Metadata.workflows() accessors", () => {
    it("Metadata.nodes() returns all @node-decorated constructors", () => {
      const nodes = Metadata.nodes();
      // The test file declares multiple @node classes: GraphToolModel,
      // GraphAddressModel, GraphCompanyModel, IfFlowModel, CodeModel, PrimNode.
      expect(nodes.length).toBeGreaterThanOrEqual(6);
      // Each entry must be a constructor function.
      for (const ctor of nodes) {
        expect(typeof ctor).toBe("function");
      }
      // The set must include the known @node-decorated classes.
      const nodeNames = nodes.map((n: any) => n.name);
      expect(nodeNames).toContain("GraphToolModel");
      expect(nodeNames).toContain("IfNode");
    });

    it("Metadata.workflows() returns all @graph-decorated constructors", () => {
      const workflows = Metadata.workflows();
      expect(workflows.length).toBeGreaterThanOrEqual(1);
      for (const ctor of workflows) {
        expect(typeof ctor).toBe("function");
      }
      const workflowNames = workflows.map((w: any) => w.name);
      expect(workflowNames).toContain("GraphWorkflowModel");
    });

    it("re-decorating the same class does not duplicate registry entries", () => {
      const before = Metadata.nodes().length;

      @node("dup-node", { kind: "dup", category: "Test" })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class DupNode extends Model {
        @output({ label: "Out" })
        out!: unknown;
      }

      // Re-apply @node to the same class — registry should not duplicate.
      const after = Metadata.nodes().length;
      expect(after).toBe(before + 1);

      // The registry is idempotent for the same constructor reference.
      const nodes = Metadata.nodes();
      const dupEntries = nodes.filter((n: any) => n.name === "DupNode");
      expect(dupEntries.length).toBe(1);
    });
  });
});
