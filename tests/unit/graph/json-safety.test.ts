/**
 * DECAF-50/P1 evidence: JSON-safety contract for canonical graph payloads.
 * Functions, undefined, non-finite numbers, class instances, symbol keys and
 * unsafe prototype keys are refused across the whole document surface.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import {
  GRAPH_UNSAFE_OBJECT_KEYS,
  cloneGraphJsonValue,
  graphJsonParser,
  graphJsonSerializer,
  isGraphJsonPrimitive,
  isGraphJsonValue,
  isGraphJsonSafeValue,
  isGraphUnsafeObjectKey,
} from "../../../src/shared/graph";
import { GraphWorkflowDocumentBuilder } from "../../../src/shared/graph";

function unsafeRecord(key: string, value: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = { safe: 1 };
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true });
  return record;
}

class Instance {
  field = 1;
}

describe("JSON safety", () => {
  describe("primitive classification", () => {
    it("classifies JSON primitives and rejects non-finite numbers", () => {
      expect(isGraphJsonPrimitive(null)).toBe(true);
      expect(isGraphJsonPrimitive("x")).toBe(true);
      expect(isGraphJsonPrimitive(42)).toBe(true);
      expect(isGraphJsonPrimitive(true)).toBe(true);
      expect(isGraphJsonPrimitive(NaN)).toBe(false);
      expect(isGraphJsonPrimitive(Infinity)).toBe(false);
      expect(isGraphJsonPrimitive(-Infinity)).toBe(false);
      expect(isGraphJsonPrimitive(undefined)).toBe(false);
      expect(isGraphJsonPrimitive({})).toBe(false);
      expect(isGraphJsonPrimitive(() => undefined)).toBe(false);
    });

    it("rejects non-finite numbers structurally at the value and safety gates", () => {
      expect(isGraphJsonValue({ n: NaN })).toBe(false);
      expect(isGraphJsonSafeValue({ n: NaN })).toBe(false);
      expect(isGraphJsonValue([1, 2, NaN])).toBe(false);
      expect(isGraphJsonSafeValue({ a: { b: Infinity } })).toBe(false);
    });
  });

  describe("isGraphJsonValue", () => {
    it("accepts plain JSON structures and rejects non-JSON members", () => {
      expect(isGraphJsonValue(1)).toBe(true);
      expect(isGraphJsonValue([1, "a", true, null])).toBe(true);
      expect(isGraphJsonValue({ a: { b: [1, null] } })).toBe(true);
      expect(isGraphJsonValue(new Instance())).toBe(false);
      expect(isGraphJsonValue(() => undefined)).toBe(false);
      expect(isGraphJsonValue({ nested: () => undefined })).toBe(false);
    });

    it("rejects objects carrying unsafe prototype-pollutant keys", () => {
      expect(GRAPH_UNSAFE_OBJECT_KEYS).toEqual(["__proto__", "prototype", "constructor"]);
      for (const key of GRAPH_UNSAFE_OBJECT_KEYS) {
        expect(isGraphUnsafeObjectKey(key)).toBe(true);
        expect(isGraphJsonValue(unsafeRecord(key, { polluted: true }))).toBe(false);
      }
      expect(isGraphUnsafeObjectKey("safeKey")).toBe(false);
    });
  });

  describe("isGraphJsonSafeValue", () => {
    it("refuses undefined, functions, non-finite numbers and class instances", () => {
      expect(isGraphJsonSafeValue(undefined)).toBe(false);
      expect(isGraphJsonSafeValue(NaN)).toBe(false);
      expect(isGraphJsonSafeValue(Infinity)).toBe(false);
      expect(isGraphJsonSafeValue(() => undefined)).toBe(false);
      expect(isGraphJsonSafeValue(new Date())).toBe(false);
      expect(isGraphJsonSafeValue(new Instance())).toBe(false);
    });

    it("accepts nested plain JSON structures", () => {
      expect(isGraphJsonSafeValue({ a: [1, "x", true, null, { b: 2 }] })).toBe(true);
      expect(isGraphJsonSafeValue([])).toBe(true);
      expect(isGraphJsonSafeValue(null)).toBe(true);
    });

    it("refuses unsafe structures nested at any depth and unsafe keys", () => {
      expect(isGraphJsonSafeValue({ a: { b: [() => undefined] } })).toBe(false);
      expect(isGraphJsonSafeValue({ a: new Instance() })).toBe(false);
      expect(isGraphJsonSafeValue(unsafeRecord("constructor", 1))).toBe(false);
      expect(isGraphJsonSafeValue(unsafeRecord("prototype", 1))).toBe(false);
      expect(isGraphJsonSafeValue(unsafeRecord("__proto__", 1))).toBe(false);
    });
  });

  describe("cloneGraphJsonValue", () => {
    it("produces structurally equal, independent copies", () => {
      const source = { a: [1, { b: "two" }], c: null };
      const clone = cloneGraphJsonValue(source);
      expect(clone).toEqual(source);
      expect(clone).not.toBe(source);
      (clone.a as unknown[])[0] = 99;
      expect(source.a[0]).toBe(1);
    });

    it("passes primitives through unchanged", () => {
      expect(cloneGraphJsonValue(null)).toBeNull();
      expect(cloneGraphJsonValue(7)).toBe(7);
      expect(cloneGraphJsonValue("s")).toBe("s");
    });
  });

  describe("graph JSON (de)serialization", () => {
    it("round-trips JSON-safe values", () => {
      const value = { ok: [1, "two", true, null], deep: { n: 3 } };
      const serialised = graphJsonSerializer(value, 2);
      expect(graphJsonParser(serialised)).toEqual(value);
    });

    it("throws ValidationError (not raw Error) for unsafe values", () => {
      expect(() => graphJsonSerializer(() => undefined)).toThrow(ValidationError);
      expect(() => graphJsonSerializer({ f: () => undefined })).toThrow(ValidationError);
      expect(() => graphJsonSerializer(NaN)).toThrow(ValidationError);
      try {
        graphJsonSerializer(new Instance());
        fail("expected ValidationError");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).code).toBe(422);
      }
    });

    it("rejects serialized payloads that inject unsafe prototype keys", () => {
      expect(() => graphJsonParser('{"__proto__":{"polluted":true}}')).toThrow(ValidationError);
      expect(() => graphJsonParser("not json")).toThrow(ValidationError);
      expect(() => graphJsonParser(undefined as unknown as string)).toThrow(ValidationError);
    });

    it("accepts an already-safe object when passed through the parser", () => {
      const safe = { a: 1 };
      expect(graphJsonParser(safe)).toBe(safe);
    });
  });

  describe("document-level enforcement", () => {
    it("refuses unsafe members in metadata, settings and ui at build time", () => {
      const unsafeBuilds: Array<() => unknown> = [
        () => new GraphWorkflowDocumentBuilder("d", "n").setMetadata({ f: () => 1 }).build(),
        () => new GraphWorkflowDocumentBuilder("d", "n").setSettings({ f: () => 1 }).build(),
        () =>
          new GraphWorkflowDocumentBuilder("d", "n")
            .setUi({ extra: new Instance() } as never)
            .build(),
      ];
      for (const build of unsafeBuilds) {
        expect(build).toThrow(ValidationError);
      }
    });

    it("refuses document settings holding non-finite numbers through the structural guard (JSON.stringify would lose the value)", () => {
      expect(isGraphJsonSafeValue({ n: NaN })).toBe(false);
      try {
        new GraphWorkflowDocumentBuilder("d", "n").setSettings({ n: NaN }).build();
        fail("expected ValidationError");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).code).toBe(422);
        expect((e as ValidationError).message).toContain(
          "Document settings must be JSON-safe (a map of JSON-safe values)"
        );
      }
    });

    it("refuses node parameters holding function values", () => {
      expect(
        () =>
          new GraphWorkflowDocumentBuilder("d", "n")
            .addNode({ id: "n1", kind: "core.transform", parameters: { fn: () => 1 } as never })
            .build()
      ).toThrow(/JSON-safe/);
    });

    it("refuses literal bindings holding non-finite numbers", () => {
      expect(
        () =>
          new GraphWorkflowDocumentBuilder("d", "n")
            .addNode({
              id: "n1",
              kind: "core.transform",
              parameters: {},
              inputBindings: { in1: { mode: "literal", value: NaN } },
            })
            .build()
      ).toThrow(ValidationError);
    });
  });
});
