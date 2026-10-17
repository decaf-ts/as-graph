/**
 * @module as-graph/tests/unit/graph/mastra/MastraScheduleTrigger
 * @summary Unit tests for the SAA-836 M6 mastra declarative-schedule
 * translation of the `core.trigger.schedule` kind.
 * @description Pins the cron/timezone resolution (string or `{ expression }`
 * parameter shape with the node's `trigger` metadata as fallback), the stable
 * schedule id (the node id), the fail-closed paths (no resolvable cron, invalid
 * cron/timezone — validated with mastra's own `validateCron`, never a local
 * parser, both surface `GRAPH_MASTRA_SCHEDULE_UNAVAILABLE`), the no-schedule
 * no-op, and that the compiled workflow is created with the declarative
 * `schedule` input (the mastra scheduler starts runs on each cron fire).
 */
import { describe, it, expect } from "@jest/globals";
import {
  GRAPH_MASTRA_SCHEDULE_TRIGGER_KIND,
  mastraScheduleConfigsOf,
} from "../../../../src/mastra/MastraScheduleTrigger";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { createMastraDefaultStepHandlers } from "../../../../src/mastra/MastraDefaultStepHandlers";
import { GRAPH_MASTRA_SCHEDULE_UNAVAILABLE } from "../../../../src/mastra/types";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { document, node } from "../../../../src/workflows/builders";
import { graphCodeOf } from "./helpers";

/** A document with the given schedule trigger nodes. */
function scheduleDocument(
  scheduleNodes: Array<{
    id: string;
    parameters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>
): GraphWorkflowDocument {
  return document({
    id: "saa-836-m6-schedule",
    name: "saa-836-m6-schedule",
    nodes: [
      ...scheduleNodes.map((scheduleNode) =>
        node(
          scheduleNode.id,
          "core.trigger.schedule",
          scheduleNode.parameters,
          scheduleNode.metadata
            ? { metadata: scheduleNode.metadata as never }
            : {}
        )
      ),
    ],
  });
}

describe("mastraScheduleConfigsOf (SAA-836 M6)", () => {
  it("covers the core.trigger.schedule kind", () => {
    expect(GRAPH_MASTRA_SCHEDULE_TRIGGER_KIND).toBe("core.trigger.schedule");
  });

  it("returns undefined when the document declares no schedule trigger", () => {
    expect(mastraScheduleConfigsOf(scheduleDocument([]))).toBeUndefined();
  });

  it("resolves the cron from the string parameter with the node id as schedule id", () => {
    const configs = mastraScheduleConfigsOf(
      scheduleDocument([
        { id: "nightly", parameters: { cron: "0 3 * * *" } },
      ])
    );
    expect(configs).toEqual([{ id: "nightly", cron: "0 3 * * *" }]);
  });

  it("resolves the cron from mastra's { expression } parameter shape", () => {
    const configs = mastraScheduleConfigsOf(
      scheduleDocument([
        { id: "hourly", parameters: { cron: { expression: "0 * * * *" } } },
      ])
    );
    expect(configs).toEqual([{ id: "hourly", cron: "0 * * * *" }]);
  });

  it("falls back to the node's trigger metadata when no cron parameter is declared", () => {
    const configs = mastraScheduleConfigsOf(
      scheduleDocument([
        {
          id: "legacy",
          parameters: {},
          metadata: { trigger: { schedule: "*/15 * * * *", timezone: "UTC" } },
        },
      ])
    );
    expect(configs).toEqual([
      { id: "legacy", cron: "*/15 * * * *", timezone: "UTC" },
    ]);
  });

  it("resolves the timezone parameter and omits it when none is declared", () => {
    const configs = mastraScheduleConfigsOf(
      scheduleDocument([
        {
          id: "zoned",
          parameters: { cron: "0 9 * * 1-5", timezone: "Europe/Lisbon" },
        },
      ])
    );
    expect(configs).toEqual([
      { id: "zoned", cron: "0 9 * * 1-5", timezone: "Europe/Lisbon" },
    ]);
  });

  it("resolves one config per schedule trigger node", () => {
    const configs = mastraScheduleConfigsOf(
      scheduleDocument([
        { id: "a", parameters: { cron: "0 * * * *" } },
        { id: "b", parameters: { cron: { expression: "30 * * * *" } } },
      ])
    );
    expect(configs).toEqual([
      { id: "a", cron: "0 * * * *" },
      { id: "b", cron: "30 * * * *" },
    ]);
  });

  it("fails closed with GRAPH_MASTRA_SCHEDULE_UNAVAILABLE when no cron is resolvable", () => {
    expect(
      graphCodeOf(() =>
        mastraScheduleConfigsOf(scheduleDocument([{ id: "bare" }]))
      )
    ).toBe(GRAPH_MASTRA_SCHEDULE_UNAVAILABLE);
  });

  it("fails closed when mastra's validateCron rejects the expression", () => {
    expect(
      graphCodeOf(() =>
        mastraScheduleConfigsOf(
          scheduleDocument([{ id: "bad", parameters: { cron: "61 * * * *" } }])
        )
      )
    ).toBe(GRAPH_MASTRA_SCHEDULE_UNAVAILABLE);
    expect(
      graphCodeOf(() =>
        mastraScheduleConfigsOf(
          scheduleDocument([
            { id: "bad", parameters: { cron: "not-a-cron" } },
          ])
        )
      )
    ).toBe(GRAPH_MASTRA_SCHEDULE_UNAVAILABLE);
  });

  it("fails closed when mastra's validateCron rejects the timezone", () => {
    expect(
      graphCodeOf(() =>
        mastraScheduleConfigsOf(
          scheduleDocument([
            {
              id: "bad-zone",
              parameters: { cron: "0 0 * * *", timezone: "Not/AZone" },
            },
          ])
        )
      )
    ).toBe(GRAPH_MASTRA_SCHEDULE_UNAVAILABLE);
  });
});

describe("compiled workflow schedule surface (SAA-836 M6)", () => {
  it("creates the compiled workflow with the declarative schedule config", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const compiled = compiler.compile(
      scheduleDocument([{ id: "hourly", parameters: { cron: "0 * * * *" } }])
    );
    const scheduleConfigs = (
      compiled.workflow as unknown as {
        getScheduleConfigs?: () => Array<Record<string, unknown>>;
      }
    ).getScheduleConfigs?.();
    expect(scheduleConfigs).toEqual([{ id: "hourly", cron: "0 * * * *" }]);
  });

  it("declares no schedule when the document has no schedule trigger", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const compiled = compiler.compile(
      document({
        id: "saa-836-m6-unscheduled",
        name: "saa-836-m6-unscheduled",
        nodes: [node("leaf", "value", { value: 1 })],
      })
    );
    const scheduleConfigs = (
      compiled.workflow as unknown as {
        getScheduleConfigs?: () => Array<Record<string, unknown>>;
      }
    ).getScheduleConfigs?.();
    expect(scheduleConfigs).toEqual([]);
  });

  it("fails closed at compile when the schedule trigger declares no cron", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    expect(
      graphCodeOf(() =>
        compiler.compile(scheduleDocument([{ id: "bare" }]))
      )
    ).toBe(GRAPH_MASTRA_SCHEDULE_UNAVAILABLE);
  });
});
