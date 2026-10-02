/**
 * @module as-graph/tests/unit/graph/GraphValueTemplate.test
 * @summary SAA-2013 evidence: `GraphValueTemplate` is the JSON-safe persisted
 * representation for user-controllable node properties supplied as code
 * expressions or text templates. A template stored in a node instance's
 * `parameters` survives a workflow document save/load round-trip and resolves
 * through `resolveGraphValueTemplate`; a straight literal value is returned
 * unchanged.
 */
import { describe, it, expect } from "@jest/globals";
import {
  GRAPH_VALUE_TEMPLATE_LANGUAGES,
  GRAPH_VALUE_TEMPLATE_MODES,
  graphValueTemplateDefaultLanguage,
  graphWorkflowDocumentDeserializer,
  graphWorkflowDocumentSerializer,
  GraphWorkflowDocumentBuilder,
  isGraphValueTemplate,
  isGraphValueTemplateLanguage,
  isGraphValueTemplateMode,
  resolveGraphValueTemplate,
} from "../../../src/shared/graph";
import type {
  GraphJsonValue,
  GraphValueTemplate,
  GraphValueTemplateLanguage,
} from "../../../src/shared/graph";

const EXPRESSION_TEMPLATE: GraphValueTemplate = {
  mode: "expression",
  expression: "input.value + 1",
  language: "javascript",
  metadata: { hint: "counter" },
};

const TEXT_TEMPLATE: GraphValueTemplate = {
  mode: "template",
  expression: "Hello {{name}}",
};

describe("GraphValueTemplate guards", () => {
  it("declares exactly the four value-mode languages and two modes", () => {
    expect(GRAPH_VALUE_TEMPLATE_MODES).toEqual(["expression", "template"]);
    expect(GRAPH_VALUE_TEMPLATE_LANGUAGES).toEqual([
      "javascript",
      "typescript",
      "json",
      "text",
    ]);
    expect(isGraphValueTemplateMode("expression")).toBe(true);
    expect(isGraphValueTemplateMode("template")).toBe(true);
    expect(isGraphValueTemplateMode("literal")).toBe(false);
    expect(isGraphValueTemplateLanguage("typescript")).toBe(true);
    expect(isGraphValueTemplateLanguage("json")).toBe(true);
    expect(isGraphValueTemplateLanguage("python")).toBe(false);
  });

  it("recognizes a value template and rejects malformed shapes", () => {
    expect(isGraphValueTemplate(EXPRESSION_TEMPLATE)).toBe(true);
    expect(isGraphValueTemplate(TEXT_TEMPLATE)).toBe(true);
    expect(isGraphValueTemplate("literal")).toBe(false);
    expect(isGraphValueTemplate({ mode: "expression" })).toBe(false);
    expect(isGraphValueTemplate({ mode: "expression", expression: "" })).toBe(
      false
    );
    expect(isGraphValueTemplate({ mode: "bogus", expression: "x" })).toBe(false);
    expect(
      isGraphValueTemplate({
        mode: "expression",
        expression: "x",
        language: "python",
      })
    ).toBe(false);
  });

  it("defaults the language per mode", () => {
    expect(graphValueTemplateDefaultLanguage("expression")).toBe("javascript");
    expect(graphValueTemplateDefaultLanguage("template")).toBe("text");
  });
});

describe("resolveGraphValueTemplate", () => {
  it("returns a straight literal value unchanged without invoking the evaluator", () => {
    const calls: string[] = [];
    const evaluate = (
      expression: string,
      language: GraphValueTemplateLanguage
    ): GraphJsonValue => {
      calls.push(`${language}:${expression}`);
      return "evaluated";
    };
    const literals: GraphJsonValue[] = [
      42,
      "text",
      true,
      null,
      { nested: [1, 2] },
    ];
    for (const literal of literals) {
      expect(resolveGraphValueTemplate(literal, evaluate)).toEqual(literal);
    }
    expect(calls).toEqual([]);
  });

  it("evaluates an expression with its declared language", () => {
    const calls: string[] = [];
    const evaluate = (
      expression: string,
      language: GraphValueTemplateLanguage
    ): GraphJsonValue => {
      calls.push(`${language}:${expression}`);
      return "evaluated";
    };
    expect(resolveGraphValueTemplate(EXPRESSION_TEMPLATE, evaluate)).toBe(
      "evaluated"
    );
    expect(calls).toEqual(["javascript:input.value + 1"]);
  });

  it("falls back to the mode default language when none is declared", () => {
    const calls: string[] = [];
    const evaluate = (
      expression: string,
      language: GraphValueTemplateLanguage
    ): GraphJsonValue => {
      calls.push(`${language}:${expression}`);
      return "evaluated";
    };
    resolveGraphValueTemplate(TEXT_TEMPLATE, evaluate);
    expect(calls).toEqual(["text:Hello {{name}}"]);
  });
});

describe("GraphValueTemplate persistence", () => {
  it("survives a workflow document save/load round-trip in the node parameters", () => {
    const document = new GraphWorkflowDocumentBuilder(
      "templates",
      "Templates"
    )
      .addNode({
        id: "code-node",
        kind: "core.utility.code",
        parameters: {
          defaultCode: EXPRESSION_TEMPLATE as unknown as GraphJsonValue,
          message: TEXT_TEMPLATE as unknown as GraphJsonValue,
          literal: "plain",
        },
      })
      .build();

    const saved = graphWorkflowDocumentSerializer(document);
    const loaded = graphWorkflowDocumentDeserializer(saved);

    const parameters = loaded.nodes[0].parameters;
    expect(parameters["defaultCode"]).toEqual(EXPRESSION_TEMPLATE);
    expect(parameters["message"]).toEqual(TEXT_TEMPLATE);
    expect(parameters["literal"]).toBe("plain");
    expect(isGraphValueTemplate(parameters["defaultCode"])).toBe(true);
    expect(isGraphValueTemplate(parameters["message"])).toBe(true);
  });

  it("resolves the persisted templates through resolveGraphValueTemplate after load", () => {
    const document = new GraphWorkflowDocumentBuilder(
      "templates",
      "Templates"
    )
      .addNode({
        id: "code-node",
        kind: "core.utility.code",
        parameters: {
          defaultCode: EXPRESSION_TEMPLATE as unknown as GraphJsonValue,
          message: TEXT_TEMPLATE as unknown as GraphJsonValue,
          literal: 7,
        },
      })
      .build();

    const loaded = graphWorkflowDocumentDeserializer(
      graphWorkflowDocumentSerializer(document)
    );
    const parameters = loaded.nodes[0].parameters;
    const evaluate = (
      expression: string,
      language: GraphValueTemplateLanguage
    ): GraphJsonValue => `${language}:${expression}`;

    expect(
      resolveGraphValueTemplate(parameters["defaultCode"], evaluate)
    ).toBe("javascript:input.value + 1");
    expect(resolveGraphValueTemplate(parameters["message"], evaluate)).toBe(
      "text:Hello {{name}}"
    );
    expect(resolveGraphValueTemplate(parameters["literal"], evaluate)).toBe(7);
  });
});
