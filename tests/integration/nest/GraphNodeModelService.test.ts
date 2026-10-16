/**
 * @module as-graph/tests/integration/nest/GraphNodeModelService.test
 * @summary SAA-774 R3 verification: booting {@link GraphExecutionModule} exposes
 * the registered node-kind catalogue through {@link GraphNodeModelService} and
 * {@link GraphNodeRepository} over the RAM adapter, so every built-in kind is
 * reachable through repository/adapter CRUD/listing for any engine driver.
 * @description Boots the real dynamic module with `initAdapter: true`, resolves
 * `GraphNodeModelService` from the Nest container, and asserts:
 * - `listNodes()`/`listManifests()` return exactly one row/manifest per built-in
 *   catalogue kind (the expected set is derived from the live catalogue, never
 *   hard-coded);
 * - each persisted manifest deep-equals the catalogue manifest it was mirrored
 *   from;
 * - `GraphNodeRepository` read/list works through the same RAM adapter.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { Adapter, Repository } from "@decaf-ts/core";
import type { GraphNodeManifest } from "../../../src/shared/graph";
import { GraphNodeModel } from "../../../src/shared/graph";
import { GraphNodeRepository } from "../../../src/ram";
import {
  GraphNodeCatalogue,
  GraphNodeModelService,
} from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";

jest.setTimeout(60000);

describe("GraphExecutionModule node-kind exposure (SAA-774 R3)", () => {
  let app: INestApplication;
  let service: GraphNodeModelService;
  let catalogue: GraphNodeCatalogue;

  /** The built-in catalogue kinds sorted, the expected row/manifest set. */
  let expectedKinds: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphExecutionModule.forRoot({
          initAdapter: true,
          runs: { auth: "optional", allowAnonymousAccess: true },
          workflows: { auth: "optional", allowAnonymousAccess: true },
        }),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    service = moduleRef.get(GraphNodeModelService);
    catalogue = moduleRef.get(GraphNodeCatalogue);
    expectedKinds = catalogue.listKinds().slice().sort();
  }, 30000);

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }, 30000);

  it("resolves GraphNodeModelService from the Nest container", () => {
    expect(service).toBeInstanceOf(GraphNodeModelService);
    expect(expectedKinds.length).toBeGreaterThan(0);
  });

  it("listNodes() returns exactly one row per built-in catalogue kind", async () => {
    const nodes = await service.listNodes();

    const kinds = nodes.map((node) => node.kind);
    expect(kinds.slice().sort()).toEqual(expectedKinds);
    // No duplicate kind rows: one row per catalogue kind.
    expect(new Set(kinds).size).toBe(expectedKinds.length);
    for (const kind of expectedKinds) {
      expect(nodes.filter((node) => node.kind === kind)).toHaveLength(1);
    }
  });

  it("listManifests() returns one manifest per kind, deep-equal to the catalogue manifest", async () => {
    const manifests = await service.listManifests();

    expect(manifests.map((manifest) => manifest.kind).sort()).toEqual(
      expectedKinds
    );

    const byKind = new Map<string, GraphNodeManifest>(
      manifests.map((manifest) => [manifest.kind, manifest])
    );
    for (const kind of expectedKinds) {
      expect(byKind.get(kind)).toEqual(catalogue.getManifest(kind));
    }
  });

  it("mirrors the manifest display summary into the persisted row columns", async () => {
    const nodes = await service.listNodes();

    for (const node of nodes) {
      const manifest = catalogue.getManifest(node.kind);
      expect(node.name).toEqual(manifest.display?.name);
      expect(node.category).toEqual(manifest.display?.category);
      expect(node.group).toEqual(manifest.display?.group);
      expect(node.description).toEqual(manifest.display?.description);
    }
  });

  it("GraphNodeRepository read/list works through the RAM adapter", async () => {
    const adapter = Adapter.current;
    expect(adapter).toBeDefined();

    const repo = Repository.forModel(
      GraphNodeModel,
      adapter.alias
    ) as GraphNodeRepository;

    const rows = (await repo.select().execute()) as GraphNodeModel[];
    expect(rows.map((row) => row.kind).sort()).toEqual(expectedKinds);

    const kind = expectedKinds[0];
    const row = (await repo.read(kind)) as GraphNodeModel;
    expect(row).toBeInstanceOf(GraphNodeModel);
    expect(row.kind).toBe(kind);
    expect(row.manifest).toEqual(catalogue.getManifest(kind));
  });
});
