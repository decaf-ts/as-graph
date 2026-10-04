/**
 * @module as-graph/tests/unit/graph/dagster/DagsterWorkflowTranslator.test
 * @summary Unit tests for the Dagster workflow translator (SAA-195).
 * @description Proves the SAA-193 C2–C10 translation invariants, the §4.2
 * node-kind mappings, the §7.3 loud-fail rules, the pinned version/source, and
 * deterministic output.
 */
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import {
  DAGSTER_PINNED_SOURCE,
  DAGSTER_PINNED_VERSION,
  DAGSTER_TAG_NAMESPACE,
} from "../../../../src/dagster/constants";
import {
  assertDagsterImports,
  DagsterWorkflowTranslator,
} from "../../../../src/dagster/DagsterWorkflowTranslator";
import { DAGSTER_CAPABILITY_TABLE } from "../../../../src/dagster/capabilities";
import { isDagsterIdentifier } from "../../../../src/dagster/DagsterIdentifier";
import {
  documentEdge,
  documentNode,
} from "../engine-fixtures";

const translator = new DagsterWorkflowTranslator();

/** Builds a minimal two-node document with the given node definitions. */
function documentWith(
  nodes: ReturnType<typeof documentNode>[]
): GraphWorkflowDocument {
  const edges =
    nodes.length > 1
      ? [
          documentEdge("e1", ["node", nodes[0].id, "result"], [
            "node",
            nodes[1].id,
            "value",
          ]),
        ]
      : [];
  return {
    id: "dagster-wf",
    name: "dagster-wf",
    inputs: [{ id: "a" }, { id: "b" }],
    outputs: [{ id: "result" }],
    nodes,
    edges,
  };
}

/** A document whose first node carries an invalid condition path. */
function badPathDocument(path: string): GraphWorkflowDocument {
  return {
    id: "bad-path",
    name: "bad-path",
    inputs: [],
    outputs: [],
    nodes: [
      documentNode("router", "core.flow.if", {
        condition: { op: "eq", left: { path }, right: { const: 1 } },
        else: true,
      }),
    ],
    edges: [],
  };
}

describe("DagsterWorkflowTranslator", () => {
  it("pins the Dagster engine version with provenance", () => {
    const artifact = translator.translate(
      documentWith([documentNode("log", "core.flow.log")])
    );
    expect(artifact.pinnedVersion).toBe(DAGSTER_PINNED_VERSION);
    expect(artifact.pinnedVersion).toBe("1.13.25");
    expect(artifact.pinnedSource).toBe(DAGSTER_PINNED_SOURCE);
    expect(artifact.python).toContain(
      `# engine: dagster==${DAGSTER_PINNED_VERSION}`
    );
    expect(artifact.python).toContain(`# source: ${DAGSTER_PINNED_SOURCE}`);
  });

  it("is deterministic: same document, same artifact", () => {
    const document = documentWith([
      documentNode("log", "core.flow.log"),
      documentNode("map", "core.utility.map"),
    ]);
    const first = translator.translate(document);
    const second = translator.translate(document);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.opNamesByNodeId).toEqual(second.opNamesByNodeId);
    expect(first.python).toBe(second.python);
  });

  describe("SAA-193 C2 — code-mode surfaces fail closed", () => {
    it("rejects a code node before translation", () => {
      expect(() =>
        translator.translate(
          documentWith([documentNode("code", "core.utility.code")])
        )
      ).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED",
        })
      );
    });

    it("rejects a code condition on a flow-control carrier", () => {
      const document: GraphWorkflowDocument = {
        id: "code-cond",
        name: "code-cond",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("router", "core.flow.if", {
            condition: { type: "code", code: "return true" },
          }),
        ],
        edges: [],
      };
      expect(() => translator.translate(document)).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED",
        })
      );
    });
  });

  describe("SAA-193 C5 — deterministic identifier sanitizer", () => {
    it("passes valid identifiers and synthesizes invalid ones", () => {
      expect(isDagsterIdentifier("adder")).toBe(true);
      expect(isDagsterIdentifier("node-1")).toBe(false);
      expect(isDagsterIdentifier("class")).toBe(false);
      expect(isDagsterIdentifier("dagster")).toBe(false);
    });

    it("synthesizes n_<hash> deterministically", () => {
      const first = translator.translate(
        documentWith([documentNode("node-1", "core.flow.log")])
      );
      const second = translator.translate(
        documentWith([documentNode("node-1", "core.flow.log")])
      );
      const opName = first.opNamesByNodeId["node-1"];
      expect(opName).toMatch(/^n_[0-9a-f]{16}$/);
      expect(second.opNamesByNodeId["node-1"]).toBe(opName);
      expect(first.python).toContain(opName);
    });
  });

  describe("SAA-193 C4/C6 — user data travels as config, never code", () => {
    it("does not inline node parameters into generated Python", () => {
      const marker = "USER_SECRET_MARKER_42";
      const document = documentWith([
        documentNode("log", "core.flow.log", { marker }),
      ]);
      const artifact = translator.translate(document);
      const opName = artifact.opNamesByNodeId["log"];
      expect(artifact.python).not.toContain(marker);
      expect(artifact.runConfig.ops[opName].config["parameters"]).toEqual({
        marker,
      });
      expect(artifact.ops[0].code).not.toContain(marker);
    });
  });

  describe("SAA-193 C7 — validated condition grammar", () => {
    it("accepts dotted alphanumeric paths", () => {
      const artifact = translator.translate(badPathDocument("a.b_1"));
      expect(artifact.ops[0].config).toBeDefined();
    });

    it.each([
      "a b",
      "a'b",
      'a"b',
      "a\\b",
      "a$b",
      "a{b}",
    ])("rejects path %p", (path) => {
      expect(() => translator.translate(badPathDocument(path))).toThrow(
        expect.objectContaining({ graphCode: "GRAPH_DAGSTER_PATH_REJECTED" })
      );
    });
  });

  describe("SAA-193 C8 — tracing data only in namespaced run tags", () => {
    it("namespaces every generated run tag", () => {
      const artifact = translator.translate(
        documentWith([documentNode("log", "core.flow.log")])
      );
      const keys = Object.keys(artifact.tags);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.startsWith(DAGSTER_TAG_NAMESPACE)).toBe(true);
      }
      expect(artifact.tags[`${DAGSTER_TAG_NAMESPACE}workflowId`]).toBe(
        "dagster-wf"
      );
    });
  });

  describe("SAA-193 C9 — import allowlist", () => {
    it("only ever emits the allowlisted dagster import", () => {
      const artifact = translator.translate(
        documentWith([documentNode("log", "core.flow.log")])
      );
      expect(artifact.imports).toEqual(["dagster"]);
      expect(() => assertDagsterImports(artifact.imports)).not.toThrow();
      expect(() => assertDagsterImports(["os"])).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_IMPORT_NOT_ALLOWED",
        })
      );
    });
  });

  describe("SAA-193 C10 — translation-time JSON safety", () => {
    it("rejects a non-JSON-safe parameter", () => {
      const document = documentWith([
        documentNode("log", "core.flow.log", {
          fn: (() => undefined) as unknown as never,
        }),
      ]);
      expect(() => translator.translate(document)).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_TRANSLATION_JSON_UNSAFE",
        })
      );
    });
  });

  describe("§4.2 node-kind mappings", () => {
    it("maps switch to a router op with optional outputs", () => {
      const document: GraphWorkflowDocument = {
        id: "switch-wf",
        name: "switch-wf",
        inputs: [],
        outputs: [],
        nodes: [
          documentNode("route", "core.flow.switch", {}, {
            metadata: {
              switch: {
                cases: [
                  {
                    id: "c1",
                    label: "one",
                    condition: {
                      op: "eq",
                      left: { path: "value" },
                      right: { const: 1 },
                    },
                    outputPort: "case_one",
                  },
                ],
                hasDefault: true,
                defaultPort: "default",
              },
            },
          }),
        ],
        edges: [],
      };
      const artifact = translator.translate(document);
      const op = artifact.ops[0];
      expect(op.role).toBe("router");
      expect(op.outputs).toEqual(["case_one", "default"]);
      expect(op.optionalOutputs).toEqual(["case_one", "default"]);
      expect(op.code).toContain("is_required=False");
    });

    it("maps foreach to a DynamicOut fan-out", () => {
      const artifact = translator.translate(
        documentWith([documentNode("each", "core.loop.foreach")])
      );
      const op = artifact.ops[0];
      expect(op.role).toBe("foreach");
      expect(op.code).toContain("dagster.DynamicOut()");
      expect(op.code).toContain("dagster.DynamicOutput");
    });

    it("maps a schedule trigger to a ScheduleDefinition", () => {
      const artifact = translator.translate(
        documentWith([
          documentNode("sched", "core.trigger.schedule", {
            cron: "0 * * * *",
          }),
        ])
      );
      expect(artifact.schedules).toHaveLength(1);
      expect(artifact.schedules[0].cron).toBe("0 * * * *");
      expect(artifact.schedules[0].code).toContain(
        "dagster.ScheduleDefinition"
      );
    });

    it("maps a webhook trigger to a sensor", () => {
      const artifact = translator.translate(
        documentWith([documentNode("hook", "core.trigger.webhook")])
      );
      expect(artifact.sensors).toHaveLength(1);
      expect(artifact.sensors[0].triggerKind).toBe("core.trigger.webhook");
      expect(artifact.sensors[0].code).toContain("@dagster.sensor");
    });

    it("declares a manual trigger as an extension point", () => {
      const artifact = translator.translate(
        documentWith([documentNode("manual", "core.trigger.manual")])
      );
      expect(artifact.schedules).toHaveLength(0);
      expect(artifact.sensors).toHaveLength(0);
      expect(artifact.ops).toHaveLength(0);
    });
  });

  describe("§7.3 loud-fail invariants", () => {
    it.each([
      "core.loop.while",
      "core.loop.until",
      "core.flow.humanApproval",
      "core.flow.break",
    ])("rejects unsupported kind %s", (kind) => {
      expect(() =>
        translator.translate(documentWith([documentNode("x", kind)]))
      ).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_UNSUPPORTED_KIND",
        })
      );
    });

    it("rejects an unmapped custom kind without a resolver", () => {
      expect(() =>
        translator.translate(documentWith([documentNode("x", "custom.kind")]))
      ).toThrow(
        expect.objectContaining({
          graphCode: "GRAPH_DAGSTER_UNSUPPORTED_KIND",
        })
      );
    });

    it("translates a custom kind through the host op resolver", () => {
      const resolved = new DagsterWorkflowTranslator({
        opResolver: () => ({
          body: "return context.resources.as_graph.execute_node(config=config)",
        }),
      });
      const artifact = resolved.translate(
        documentWith([documentNode("x", "custom.kind")])
      );
      expect(artifact.ops[0].opName).toBe("x");
      expect(artifact.python).toContain("execute_node");
    });
  });

  it("exports the capability table with declared verdicts", () => {
    const byFeature = Object.fromEntries(
      DAGSTER_CAPABILITY_TABLE.map((row) => [row.feature, row.verdict])
    );
    expect(byFeature["while / until loop"]).toBe("not_supported");
    expect(byFeature["suspend / resume"]).toBe("not_supported");
    expect(byFeature["code-mode surface"]).toBe("not_supported");
    expect(byFeature["if / switch routing"]).toBe("supported");
    expect(byFeature["agent / custom node kinds"]).toBe("extension_point");
  });
});
