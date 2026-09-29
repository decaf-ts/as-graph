/**
 * DECAF-50 follow-up (SAA-1649) evidence: a port's `@uielement` decoration is
 * carried onto the compiled node manifest as a JSON-safe `element` field.
 *
 * A port whose property declares `@uielement(tag, props)` emits
 * `element: { tag, serialize, props: { ...props, name } }` — `name` is the
 * auto-added property key from `uielement()`. A port without `@uielement` stays
 * behavior-neutral (no `element` key). A port whose `@uielement` props carry a
 * non-JSON-safe value (a function or class instance) must not leak that value,
 * and the manifest must remain serializable. Serialization/deserialization
 * round-trips preserve the `element` field.
 */
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

@node("manifest.element")
@model()
class ElementNode extends Model {
  @uielement("code-editor", { label: "Code", placeholder: "// User-authored JS code" })
  @port(PortDirection.INPUT)
  code!: string;

  @port(PortDirection.INPUT)
  plain!: string;

  @uielement("input", { label: "Result" })
  @port(PortDirection.OUTPUT)
  result!: string;
}

@node("manifest.element.unsafe")
@model()
class UnsafeElementNode extends Model {
  @uielement("code-editor", {
    label: "Code",
    hook: () => "not-json-safe",
  } as never)
  @port(PortDirection.INPUT)
  code!: string;
}

const EXPECTED_ELEMENT = {
  tag: "code-editor",
  serialize: false,
  props: {
    label: "Code",
    placeholder: "// User-authored JS code",
    name: "code",
  },
};

describe("port manifest element serialization", () => {
  const manifest = graphNodeManifest(ElementNode);

  it("emits the @uielement shape on a port that declares it, including the auto-added name prop", () => {
    const code = manifest.inputs.find((entry) => entry.id === "code");
    expect(code?.element).toEqual(EXPECTED_ELEMENT);
    expect(code?.element).toEqual({
      tag: "code-editor",
      serialize: false,
      props: { label: "Code", placeholder: "// User-authored JS code", name: "code" },
    });
    const result = manifest.outputs.find((entry) => entry.id === "result");
    expect(result?.element).toEqual({
      tag: "input",
      serialize: false,
      props: { label: "Result", name: "result" },
    });
  });

  it("leaves a port without @uielement behavior-neutral (no element key)", () => {
    const plain = manifest.inputs.find((entry) => entry.id === "plain");
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty("element");
    expect(Object.keys(plain ?? {})).not.toContain("element");
  });

  it("does not leak a non-JSON-safe @uielement prop and keeps the manifest serializable", () => {
    const unsafe = graphNodeManifest(UnsafeElementNode);
    const code = unsafe.inputs.find((entry) => entry.id === "code");
    expect(code).not.toHaveProperty("element");
    expect(() => assertGraphNodeManifestSerializable(unsafe)).not.toThrow();
    expect(JSON.stringify(unsafe)).not.toContain("not-json-safe");
  });

  it("round-trips element through object, string and deserialize forms", () => {
    const cloned = deserializeGraphNodeManifest(serializeGraphNodeManifest(manifest));
    expect(cloned).toEqual(manifest);
    expect(cloned.inputs.find((entry) => entry.id === "code")?.element).toEqual(
      EXPECTED_ELEMENT
    );
    const text = graphNodeManifestSerializer(manifest);
    const parsed = graphNodeManifestDeserializer(text);
    expect(parsed).toEqual(manifest);
    expect(parsed.inputs.find((entry) => entry.id === "code")?.element).toEqual(
      EXPECTED_ELEMENT
    );
  });
});
