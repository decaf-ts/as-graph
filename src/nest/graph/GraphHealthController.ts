/**
 * @module as-graph/nest/graph/GraphHealthController
 * @summary Liveness, readiness and metrics endpoints.
 * @description
 * - `GET /graph/health/live` — the process answers (`200 {status:"ok"}`).
 * - `GET /graph/health/ready` — every dependency answers: the run store, the
 *   binary store (its blob service), the run queue and the run bus;
 *   `200` with per-check results, or `503` when any fails.
 * - `GET /graph/metrics` — Prometheus text exposition, when the host started
 *   telemetry with Prometheus enabled (`GRAPH_METRICS`); protected by a bearer
 *   token when `GRAPH_METRICS_TOKEN` is set.
 */
import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  Res,
} from "@nestjs/common";
import { Public } from "@decaf-ts/for-nest";
import { GraphExecutionEngine } from "../../engine/execution/GraphExecutionEngine";
import { GraphRunService } from "../../engine/runs/GraphRunService";
import { BlobGraphBinaryStore } from "../../engine/binary/BlobGraphBinaryStore";
import type { GraphTelemetryHandle } from "../../engine/telemetry/GraphTelemetry";

/** Injection token of the host's telemetry handle. */
export const GRAPH_TELEMETRY = Symbol("GRAPH_TELEMETRY");

/** Runs one readiness check with a timeout. */
async function check(probe: () => Promise<unknown>, timeoutMs = 3_000): Promise<string> {
  try {
    const result = await Promise.race([
      probe(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.()
      ),
    ]);
    return result === false ? "down" : "up";
  } catch (error) {
    return `down: ${(error as Error)?.message ?? String(error)}`;
  }
}

@Public()
@Controller("graph")
export class GraphHealthController {
  constructor(
    private readonly engine: GraphExecutionEngine,
    private readonly runs: GraphRunService,
    @Optional() @Inject(GRAPH_TELEMETRY) private readonly telemetry?: GraphTelemetryHandle
  ) {}

  @Get("health/live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    const store = this.engine.binaryStore;
    const checks: Record<string, string> = {
      runStore: await check(() => this.runs.getRunRecord("health-probe")),
      // Any answer from the blob service (the probe key does not exist) is up.
      binaryStore: await check(async () => {
        if (store instanceof BlobGraphBinaryStore) {
          await store.service.has("health-probe");
          return true;
        }
        return store !== undefined;
      }),
      queue: await check(() => this.runs.runQueue.ping()),
      bus: await check(() => this.runs.runBus.ping()),
    };
    const ok = Object.values(checks).every((value) => value === "up");
    const body = { status: ok ? "ok" : "unavailable", checks };
    if (!ok) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Get("metrics")
  async metrics(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }
  ): Promise<string> {
    const token = process.env["GRAPH_METRICS_TOKEN"]?.trim();
    if (token && authorization !== `Bearer ${token}`) {
      throw new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED);
    }
    if (!this.telemetry?.prometheus) {
      throw new HttpException("Prometheus metrics are not enabled", HttpStatus.NOT_FOUND);
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return this.telemetry.prometheus();
  }
}
