/**
 * @module as-graph/tests/unit/nest/GraphRunPersistenceWiring.test
 * @summary GraphExecutionModule run persistence wiring (SAA-1997 F2).
 * @description Proves {@link GraphExecutionModule.forRoot} resolves run and
 * run-event persistence through the adapter-backed `@repository()` stores
 * ({@link RamGraphRunStore} / {@link RamGraphRunEventStore}) instead of the
 * process-local in-memory maps.
 */
import { describe, it, expect } from "@jest/globals";
import { Test } from "@nestjs/testing";
import {
  RamGraphRunEventStore,
  RamGraphRunStore,
} from "../../../src/ram";
import { GraphExecutionModule } from "../../../src/nest/graph";

describe("GraphExecutionModule run persistence wiring (SAA-1997 F2)", () => {
  it("resolves the adapter-backed run and run-event stores", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot({ initAdapter: true })],
    }).compile();
    expect(moduleRef.get(RamGraphRunStore)).toBeInstanceOf(RamGraphRunStore);
    expect(moduleRef.get(RamGraphRunEventStore)).toBeInstanceOf(
      RamGraphRunEventStore
    );
    await moduleRef.close();
  });
});
