/**
 * @module as-graph/tests/unit/nest/GraphAdapterDefault
 * @summary SAA-1950 F3 regression tests: `initAdapter` fails closed.
 * @description Pins the secure adapter default of
 * {@link GraphExecutionModule.forRoot}: `initAdapter` defaults to `false`, so a
 * bare `forRoot()` (or an explicit `initAdapter: false`) never installs or
 * overrides a global Decaf adapter. When no adapter is current the module must
 * fail loudly with a {@link GraphStoreError} instead of silently bootstrapping a
 * RamAdapter. Hosts opt into standalone bootstrapping with
 * `initAdapter: true`.
 *
 * Test order is significant: the fail-closed cases run before the opt-in case,
 * because the opt-in installs the ambient RamAdapter for the rest of the file
 * (the Decaf `Adapter.current` is per-jest-module-registry state).
 */
import { describe, it, expect } from "@jest/globals";

import { Test } from "@nestjs/testing";

import { GraphStoreError } from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph";

describe("GraphExecutionModule adapter default (SAA-1950 F3)", () => {
  it("bare forRoot() rejects with a GraphStoreError when no Decaf adapter is current", async () => {
    await expect(
      Test.createTestingModule({
        imports: [GraphExecutionModule.forRoot()],
      }).compile()
    ).rejects.toBeInstanceOf(GraphStoreError);
  });

  it("explicit initAdapter:false rejects the same way", async () => {
    await expect(
      Test.createTestingModule({
        imports: [GraphExecutionModule.forRoot({ initAdapter: false })],
      }).compile()
    ).rejects.toThrow(/requires a configured Decaf adapter/);
  });

  it("initAdapter:true installs the standalone RamAdapter and boots", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot({ initAdapter: true })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app).toBeDefined();
    await app.close();
  });
});
