/**
 * @module as-graph/tests/fixtures/workflows/value-templates
 * @summary Demo workflow: user properties stored as `GraphValueTemplate`s.
 * @description Covers `core.utility.log` carrying the `code-expression` and
 * `text-template` user-property combos as `GraphValueTemplate` objects. The
 * execution engine resolves each template through the code-evaluator VM at
 * execution time (DECAF-32 §22.4), so the node receives the resolved value.
 * Combos: text template, code expression (user property), exposed ports and
 * defaults.
 */
import type { GraphValueTemplate } from "../../../src/shared/graph";
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const MESSAGE_TEMPLATE: GraphValueTemplate = {
  mode: "template",
  expression: "Hello {{ $input.value }}",
};

export const LEVEL_EXPRESSION_TEMPLATE: GraphValueTemplate = {
  mode: "expression",
  expression: "$input.value === 'warn' ? 'warn' : 'info'",
  language: "javascript",
};

export const valueTemplatesDocument = document({
  id: "fixture-value-templates",
  name: "fixture-value-templates",
  inputs: [port("name")],
  outputs: [port("result")],
  nodes: [
    node("expressionLog", "core.utility.log", {
      level: LEVEL_EXPRESSION_TEMPLATE,
    }),
    node("templateLog", "core.utility.log", { message: MESSAGE_TEMPLATE }),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "name"], ["node", "expressionLog", "value"]),
    edge("e2", ["node", "expressionLog", "value"], ["node", "sink", "value"]),
    edge("e3", ["node", "expressionLog", "value"], ["workflow", "result"]),
    edge("e4", ["workflow", "name"], ["node", "templateLog", "value"]),
  ],
});

export const valueTemplatesFixture: GraphWorkflowFixture = {
  id: valueTemplatesDocument.id,
  document: valueTemplatesDocument,
  kinds: ["core.utility.log", "result"],
  combos: ["text-template", "code-expression", "exposed-ports", "defaults"],
  executable: true,
  inputs: { name: "warn" },
  expectedOutputs: { result: "warn" },
};
