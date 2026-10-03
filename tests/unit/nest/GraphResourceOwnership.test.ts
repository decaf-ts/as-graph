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
