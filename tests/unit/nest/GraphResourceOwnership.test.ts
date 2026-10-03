/**
 * @module as-graph/tests/unit/nest/GraphResourceOwnership.test
 * @summary SAA-76: direct unit coverage for the fail-closed graph resource
 * ownership predicate `canAccessGraphResource` and its throwing wrapper
 * `assertGraphResourceOwnership`.
 * @description Pins the semantics the two serving list routes rely on:
 * owner-less resources are visible to everyone, a named caller sees their own plus
 * owner-less resources, and an anonymous caller sees only owner-less resources
 * unless the explicit `allowAnonymousAccess` tolerance is set.
 */
import { describe, it, expect } from "@jest/globals";
import { ForbiddenError } from "@decaf-ts/core";

import {
  assertGraphResourceOwnership,
  canAccessGraphResource,
  canAccessGraphResourcePayload,
} from "../../../src/engine/runs/ownership";

describe("canAccessGraphResource (SAA-76 fail-closed ownership predicate)", () => {
  it("treats owner-less resources as visible to every caller", () => {
    const ownerLess = [null, undefined, {}, { owner: null }, { owner: "" }];
    for (const resource of ownerLess) {
      expect(canAccessGraphResource(resource, "alice")).toBe(true);
      expect(canAccessGraphResource(resource, "bob")).toBe(true);
      expect(canAccessGraphResource(resource, null)).toBe(true);
      expect(canAccessGraphResource(resource, undefined)).toBe(true);
      expect(canAccessGraphResource(resource, "")).toBe(true);
      expect(
        canAccessGraphResource(resource, null, { allowAnonymousAccess: false })
      ).toBe(true);
    }
  });

  it("lets a named caller see their own resources but not a foreign owner's", () => {
    const owned = { owner: "alice" };
    expect(canAccessGraphResource(owned, "alice")).toBe(true);
    expect(canAccessGraphResource(owned, "bob")).toBe(false);
    expect(canAccessGraphResource(owned, "alice", { allowAnonymousAccess: false })).toBe(
      true
    );
    expect(canAccessGraphResource(owned, "bob", { allowAnonymousAccess: true })).toBe(
      false
    );
  });

  it("fails closed for anonymous callers unless allowAnonymousAccess is explicitly true", () => {
    const owned = { owner: "alice" };
    for (const anonymous of [null, undefined, ""]) {
      expect(canAccessGraphResource(owned, anonymous)).toBe(false);
      expect(
        canAccessGraphResource(owned, anonymous, { allowAnonymousAccess: false })
      ).toBe(false);
      expect(
        canAccessGraphResource(owned, anonymous, { allowAnonymousAccess: true })
      ).toBe(true);
      // owner-less resources stay visible to anonymous callers either way
      expect(canAccessGraphResource(null, anonymous)).toBe(true);
    }
  });

  it("assertGraphResourceOwnership delegates to the predicate and throws ForbiddenError on denial", () => {
    expect(() =>
      assertGraphResourceOwnership({ owner: "alice" }, "bob", {
        resourceKind: "Graph workflow",
        resourceId: "wf-1",
      })
    ).toThrow(ForbiddenError);

    expect(() =>
      assertGraphResourceOwnership({ owner: "alice" }, "alice", {
        resourceKind: "Graph workflow",
        resourceId: "wf-1",
      })
    ).not.toThrow();

    expect(() =>
      assertGraphResourceOwnership(null, "bob", {
        resourceKind: "Graph workflow",
        resourceId: "wf-1",
      })
    ).not.toThrow();

    expect(() =>
      assertGraphResourceOwnership({ owner: "alice" }, null, {
        resourceKind: "Graph workflow",
        resourceId: "wf-1",
      })
    ).toThrow(ForbiddenError);

    expect(() =>
      assertGraphResourceOwnership({ owner: "alice" }, null, {
        allowAnonymousAccess: true,
        resourceKind: "Graph workflow",
        resourceId: "wf-1",
      })
    ).not.toThrow();
  });
});

describe("canAccessGraphResourcePayload (SAA-93 F1 payload predicate)", () => {
  it("serves a row's payload only to the caller that owns the row", () => {
    const owned = { owner: "alice" };
    expect(canAccessGraphResourcePayload(owned, "alice")).toBe(true);
    expect(canAccessGraphResourcePayload(owned, "bob")).toBe(false);
    expect(canAccessGraphResourcePayload(owned, null)).toBe(false);
    expect(canAccessGraphResourcePayload(owned, undefined)).toBe(false);
    expect(canAccessGraphResourcePayload(owned, "")).toBe(false);
  });

  it("hides an owner-less row's payload from a named caller, but serves it to an owner-less caller (the F1 fix)", () => {
    const ownerLess = [null, undefined, {}, { owner: null }];
    for (const resource of ownerLess) {
      // a named caller may still *see* the row by the owner-less visibility
      // contract, but must never receive its sensitive payload
      expect(canAccessGraphResourcePayload(resource, "alice")).toBe(false);
      expect(canAccessGraphResourcePayload(resource, "bob")).toBe(false);
      // the owner-less (anonymous/standalone) caller keeps the payload
      expect(canAccessGraphResourcePayload(resource, null)).toBe(true);
      expect(canAccessGraphResourcePayload(resource, undefined)).toBe(true);
    }
  });

  it("is fail-closed even where visibility allows the row: owner-less visible to a named caller, payload still denied", () => {
    const ownerLess = { owner: null };
    expect(canAccessGraphResource(ownerLess, "alice")).toBe(true);
    expect(canAccessGraphResourcePayload(ownerLess, "alice")).toBe(false);
    const owned = { owner: "alice" };
    expect(canAccessGraphResource(owned, "bob")).toBe(false);
    expect(canAccessGraphResourcePayload(owned, "bob")).toBe(false);
  });
});
