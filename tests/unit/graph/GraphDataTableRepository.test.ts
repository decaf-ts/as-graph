/**
 * @module as-graph/tests/unit/graph/GraphDataTableRepository
 * @summary C5 regression coverage for SAA-958: data-table name scoping, row
 * size, list bounds, and table capacity.
 * @description Drives the real {@link GraphDataTableRepository} over a RAM
 * adapter for name validation, composite-key collision resistance, and the row
 * byte cap. The list bound and capacity gate are asserted through narrow query
 * seams so the tests do not have to insert 10,000 rows to prove the ceilings.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

import {
  createGraphDataTableRepository,
  type GraphDataTableRepository,
} from "../../../src/engine/store/GraphDataTableRepository";
import {
  GRAPH_DATA_TABLE_MAX_LIST_ROWS,
  GRAPH_DATA_TABLE_MAX_ROWS,
  GRAPH_DATA_TABLE_MAX_ROW_BYTES,
} from "../../../src/engine/constants";
import { createRamGraphAdapter } from "../../../src/ram";

let adapterCounter = 0;

describe("GraphDataTableRepository hardening (C5)", () => {
  let repository: GraphDataTableRepository;

  beforeEach(async () => {
    const adapter = await createRamGraphAdapter(
      `saa963-datatable-${adapterCounter++}`
    );
    repository = createGraphDataTableRepository(adapter);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects table names containing the composite-id separator", async () => {
    for (const tableName of ["a:b", ":leading", "trailing:", "a:b:c"]) {
      await expect(
        repository.insertRow(tableName, "row", { value: 1 })
      ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_INVALID_NAME" });
      await expect(
        repository.listRows(tableName)
      ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_INVALID_NAME" });
    }
  });

  it("does not let a row id smuggle in another table's namespace", async () => {
    await repository.insertRow("a", "b:c", { value: "table-a" });

    // `table "a:b" row "c"` would share the composite id `a:b:c`; the table
    // name is rejected before it can collide with or overwrite table `a`.
    await expect(
      repository.insertRow("a:b", "c", { value: "table-a-b" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_INVALID_NAME" });

    expect(await repository.readRow("a", "b:c")).toEqual({
      id: "b:c",
      value: "table-a",
    });
  });

  it("rejects a row payload over the serialized byte cap", async () => {
    const oversized = "x".repeat(GRAPH_DATA_TABLE_MAX_ROW_BYTES + 1);
    await expect(
      repository.insertRow("large", "row", { blob: oversized })
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_ROW_TOO_LARGE" });
  });

  it("caps list results at GRAPH_DATA_TABLE_MAX_LIST_ROWS", async () => {
    const limitCalls: number[] = [];
    const rows = [{ rowId: "r1", data: { value: 1 } }];
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: (value: number) => {
        limitCalls.push(value);
        return chain;
      },
      execute: async () => rows,
    };
    jest
      .spyOn(
        repository as unknown as { select: () => unknown },
        "select"
      )
      .mockReturnValue(chain);

    await repository.listRows("rows");
    await repository.listRows("rows", 3);
    await repository.listRows("rows", Number.MAX_SAFE_INTEGER);

    expect(limitCalls).toEqual([
      GRAPH_DATA_TABLE_MAX_LIST_ROWS,
      3,
      GRAPH_DATA_TABLE_MAX_LIST_ROWS,
    ]);
  });

  it("fails an insert when the table already holds the maximum row count", async () => {
    jest
      .spyOn(repository, "listRows")
      .mockResolvedValue(
        Array.from({ length: GRAPH_DATA_TABLE_MAX_ROWS }, (_, index) => ({
          id: String(index),
        }))
      );

    await expect(
      repository.insertRow("full", "overflow", { value: 1 })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DATA_TABLE_ROW_LIMIT_EXCEEDED",
    });
  });
});
