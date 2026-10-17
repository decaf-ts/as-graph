/**
 * @module tests/unit/nest/GraphBootAdapterFlavourGuard
 * @summary Regression guard: importing the graph (and transitively the mastra)
 * lane must not poison the decaf process-global current adapter flavour.
 * @description `@decaf-ts/core`'s `./fs` subpath module runs
 * `Adapter.setCurrent("fs")` as an import side effect (core 0.32.x) with no
 * adapter registered. The mastra per-layer persistence layer (SAA-836 O1)
 * statically imports `@decaf-ts/core/fs`, so every process that imports the
 * graph module chain — including every Nest module boot — used to end up with
 * `_currentFlavour === "fs"` and a failing `Adapter.current`
 * ("No Adapter registered under fs."). `MastraPersistence` repairs the side
 * effect at module load; this suite pins that repair.
 */
import { describe, it, expect } from "@jest/globals";
import { Adapter } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import { RamTransformer } from "@decaf-ts/for-http/server";
import { DecafModule } from "@decaf-ts/for-nest";
import { Test } from "@nestjs/testing";
import { GraphExecutionModule } from "../../../src/nest/graph";

describe("graph boot adapter flavour guard (SAA-836 O1)", () => {
  it("importing the graph lane leaves no unregistered current flavour", async () => {
    await DecafModule.forRootAsync({
      conf: [[RamAdapter, { user: "root" }, new RamTransformer()]],
      autoControllers: false,
    });
    expect(Adapter.currentFlavour).toBe("ram");
    expect((Adapter.current as { alias?: string }).alias).toBe("ram");
  });

  it("boots GraphExecutionModule on a decaf-provided adapter (initAdapter:false)", async () => {
    await DecafModule.forRootAsync({
      conf: [[RamAdapter, { user: "root" }, new RamTransformer()]],
      autoControllers: false,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot({ initAdapter: false })],
    }).compile();
    expect(moduleRef).toBeDefined();
  });

  it("repairs a poisoned fs flavour back to a registered ram adapter", async () => {
    await DecafModule.forRootAsync({
      conf: [[RamAdapter, { user: "root" }, new RamTransformer()]],
      autoControllers: false,
    });
    // simulate the core/fs import side effect over an established ram boot
    const { repairCoreFsCurrentFlavourSideEffect } = await import(
      "../../../src/mastra/MastraPersistence"
    );
    const internals = Adapter as unknown as { _currentFlavour?: string };
    internals._currentFlavour = "fs";
    repairCoreFsCurrentFlavourSideEffect();
    expect(Adapter.currentFlavour).toBe("ram");
    expect((Adapter.current as { alias?: string }).alias).toBe("ram");
  });

  it("clears a poisoned fs flavour when no adapter is registered at all", async () => {
    // simulate the core/fs import side effect in a fresh process: unregister
    // the ram adapter, poison the flavour, repair, restore
    const { repairCoreFsCurrentFlavourSideEffect } = await import(
      "../../../src/mastra/MastraPersistence"
    );
    const ram = Adapter.get("ram");
    Adapter.unregister("ram");
    const internals = Adapter as unknown as { _currentFlavour?: string };
    const previous = internals._currentFlavour;
    internals._currentFlavour = "fs";
    try {
      repairCoreFsCurrentFlavourSideEffect();
      expect(internals._currentFlavour).toBeUndefined();
    } finally {
      internals._currentFlavour = previous;
      Adapter._cache["ram"] = ram;
    }
  });
});
