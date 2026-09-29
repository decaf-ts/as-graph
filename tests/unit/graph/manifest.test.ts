/**
 * DECAF-50/P1 evidence: node manifests are JSON-safe, self-contained catalog
 * entries: kind resolution, display metadata, port buckets, parameters,
 * connection policies, and lossless serialization.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import { Model, model } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { node, port, PortDirection } from "../../../src/shared/graph";
import {
  assertGraphNodeManifestSerializable,
  deserializeGraphNodeManifest,
  graphNodeManifest,
  graphNodeManifestDeserializer,
  graphNodeManifestSerializer,
  serializeGraphNodeManifest,
} from "../../../src/shared/graph";
import type { GraphCodeParameter, GraphNodeManifest } from "../../../src/shared/graph";
import { ManifestTransformNode, TransformNode } from "./fixtures";

@node("manifest.bare")
@model()
class BareNode extends Model {}

@model()
class PlainModel extends Model {}

@node("manifest.code.languages")
@model()
class CodeLanguagesNode extends Model {
  @uielement("code", { label: "Ts", language: "typescript" })
  @port(PortDirection.INPUT)
  ts!: string;

  @uielement("code", { label: "Json", language: "json" })
  @port(PortDirection.INPUT)
  json!: string;

  @uielement("code", { label: "Text", language: "text" })
  @port(PortDirection.INPUT)
  text!: string;

  @uielement("code", { label: "Unknown", language: "python" })
  @port(PortDirection.INPUT)
  unknownLanguage!: string;

  @uielement("code", { label: "Defaulted" })
  @port(PortDirection.INPUT)
  defaulted!: string;
}

describe("manifest compilation", () => {
  const manifest = graphNodeManifest(ManifestTransformNode);

  it("resolves kind and display metadata from the decorated node", () => {
    expect(manifest.kind).toBe("core.transform");
    expect(manifest.display.name).toBe("ManifestTransformNode");
    expect(manifest.display.category).toBe("Transform");
    expect(manifest.display.icon).toEqual({ type: "catalogue", name: "ph:shuffle" });
    expect(manifest.display.labels).toEqual(["manifest", "e2e"]);
    expect(manifest.display.color).toBe("#123456");
  });

  it("falls back to kind defaulting and the default icon for minimal nodes", () => {
    const bare = graphNodeManifest(BareNode);
    expect(bare.kind).toBe("manifest.bare");
    expect(bare.display.icon).toEqual({ type: "catalogue", name: "ti-pointer" });
    expect(bare.inputs).toEqual([]);
    expect(bare.outputs).toEqual([]);
    expect(bare.parameters).toEqual([]);
    expect(bare.connections).toBeUndefined();
  });

  it("refuses a model class that is not decorated with @node (contract)", () => {
    try {
      graphNodeManifest(PlainModel);
      fail("expected ValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe(422);
      expect((e as ValidationError).message).toContain(
        "Node 'PlainModel' is not decorated with @node and cannot produce a manifest"
      );
    }
    const bare = graphNodeManifest(BareNode);
    expect(bare.kind).toBe("manifest.bare");
    expect(bare.inputs).toEqual([]);
    expect(bare.parameters).toEqual([]);
  });

  it("picks up the node description from graph metadata", () => {
    const transform = graphNodeManifest(TransformNode);
    expect(transform.display.description).toBe("Applies a transform to the input value");
  });

  it("buckets ports by direction with schema, category and handle", () => {
    expect(manifest.inputs.map((port) => port.id)).toEqual([
      "script",
      "notes",
      "snippet",
      "retries",
    ]);
    expect(manifest.outputs.map((port) => port.id)).toEqual(["result"]);
    expect(manifest.connections?.map((port) => port.id)).toEqual(["modelRes"]);
    const connection = manifest.connections?.[0];
    expect(connection?.direction).toBe("connection");
    expect(connection?.category).toBe("model");
    expect(connection?.handle).toBe("model");
    const script = manifest.inputs[0];
    expect(script.required).toBe(true);
    const notes = manifest.inputs[1];
    expect(notes.metadata).toEqual({ origin: "fixture" });
  });

  it("propagates node connection rules as port connection policies", () => {
    for (const port of [...manifest.inputs, ...manifest.outputs]) {
      expect(port.connectionPolicy).toEqual({
        allowSelf: false,
        allowMultiple: true,
        maxConnections: 8,
      });
    }
  });

  it("derives one parameter per input port with the right parameter type", () => {
    expect(manifest.parameters.map((parameter) => parameter.id)).toEqual([
      "script",
      "notes",
      "snippet",
      "retries",
    ]);
    const [script, notes, snippet, retries] = manifest.parameters;
    expect(script.type).toBe("object");
    expect(script.required).toBe(true);
    expect(script.defaultValue).toBe("echo");
    expect(notes.type).toBe("string");
    expect(notes.metadata).toEqual({ origin: "fixture" });
    expect(snippet.type).toBe("code");
    expect((snippet as GraphCodeParameter).language).toBe("javascript");
    expect(retries.type).toBe("number");
  });

  it("maps code ports to code parameters: language pinned to the code-language union with a javascript default", () => {
    const compiled = graphNodeManifest(CodeLanguagesNode);
    for (const parameter of compiled.parameters) {
      expect(parameter.type).toBe("code");
    }
    const languages = new Map(
      compiled.parameters.map((parameter) => [
        parameter.id,
        (parameter as GraphCodeParameter).language,
      ])
    );
    // every accepted code language: javascript, typescript, json, text
    expect(languages.get("ts")).toBe("typescript");
    expect(languages.get("json")).toBe("json");
    expect(languages.get("text")).toBe("text");
    // an unknown language prop and a missing prop both fall back to "javascript"
    expect(languages.get("unknownLanguage")).toBe("javascript");
    expect(languages.get("defaulted")).toBe("javascript");
  });

  it("honors compile-time overrides for kind, name, category and icon", () => {
    const overridden = graphNodeManifest(ManifestTransformNode, {
      kind: "custom.transform",
      name: "Custom",
      category: "Custom Category",
      icon: { type: "url", url: "https://example.invalid/icon.svg" },
    });
    expect(overridden.kind).toBe("custom.transform");
    expect(overridden.display.name).toBe("Custom");
    expect(overridden.display.category).toBe("Custom Category");
    expect(overridden.display.icon).toEqual({
      type: "url",
      url: "https://example.invalid/icon.svg",
    });
  });

  it("accepts a model instance as well as a constructor", () => {
    const fromInstance = graphNodeManifest(new ManifestTransformNode());
    expect(fromInstance.kind).toBe("core.transform");
  });
});

describe("manifest serialization", () => {
  const manifest = graphNodeManifest(ManifestTransformNode);

  it("round-trips losslessly through object and string forms", () => {
    const clone = deserializeGraphNodeManifest(serializeGraphNodeManifest(manifest));
    expect(clone).toEqual(manifest);
    const text = graphNodeManifestSerializer(manifest);
    expect(typeof text).toBe("string");
    expect(graphNodeManifestDeserializer(text)).toEqual(manifest);
  });

  it("produces serialized payloads free of functions and sentinels", () => {
    const text = graphNodeManifestSerializer(manifest);
    expect(text).not.toContain("$workflow");
    expect(text).not.toContain("function");
    expect(text).not.toContain("=>");
  });

  it("asserts serializability and refuses function members", () => {
    const tainted = {
      ...manifest,
      metadata: { hook: () => undefined },
    } as unknown as GraphNodeManifest;
    expect(() => assertGraphNodeManifestSerializable(tainted)).toThrow(ValidationError);
    expect(() => serializeGraphNodeManifest(tainted)).toThrow(ValidationError);
    expect(() => assertGraphNodeManifestSerializable(manifest)).not.toThrow();
  });

  it("refuses deserializing non-catalog payloads", () => {
    expect(() => graphNodeManifestDeserializer("{}")).toThrow(ValidationError);
    expect(() => graphNodeManifestDeserializer("not json")).toThrow(ValidationError);
  });
});
