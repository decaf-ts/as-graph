## Engine Adapters

Runbook for the engine-driver integration suites. Each suite lives in its own tree
under `tests/integration/` and exercises a real engine surface rather than an
in-memory unit seam.

| Driver | Suite tree | Package script | Engine under test |
| --- | --- | --- | --- |
| Mastra | `tests/integration/mastra/**` | `npm run test:integration:mastra` | real `@mastra/core@1.74.0` |
| Dagster | `tests/integration/dagster/**` | `npm run test:integration:dagster` | real `dagster-webserver@1.13.25` |

The engine-level suites in `tests/integration/graph/**` cover the facade
`GraphExecutionEngine` itself; the driver suites below cover a concrete backend.

### Mastra driver integration suite

Location: `tests/integration/mastra/**` (sibling to `tests/integration/graph/**`).
These are **real** integration tests against the real `@mastra/core` engine pinned at
`1.74.0` in `package.json`. They never mock `@mastra/core`: they build real
`createStep` / `createWorkflow` primitives and run real workflows, including a real
suspend/resume against a real `InMemoryStore`.

Run it:

```bash
npm install                        # once, to install the pinned @mastra/core
npm run test:integration:mastra
```

Equivalent direct invocation:

```bash
npx jest --testPathPatterns="/tests/integration/mastra" --detectOpenHandles
```

- Self-contained: no external services, network, model, or API key; deterministic.
- The suite also runs under `npm run test:integration` and `npm run test:all`; it is
  excluded from the default unit run (`npm run test:unit`).
- Jest needs no extra config: `jest.config.cjs` `testRegex` already matches
  `/tests/...test.ts`, and the `@mastra` / `@ai-sdk` / `@workflow` ts-jest transforms
  and `transformIgnorePatterns` are already wired for `@mastra/core`'s CJS-over-ESM
  runtime.

#### Coverage

| Suite | Driver surface | Real engine evidence |
| --- | --- | --- |
| `MastraCompileRunEvents.test.ts` | `MastraWorkflowCompiler`, `MastraEventBridge`, `GraphExecutionEngine` | real committed `Workflow`, real `createRun`/`stream`/`fullStream`, events and observables through the engine |
| `MastraResumeSuspend.test.ts` | `MastraGraphExecutionBackend`, `MastraResumeGuard` | real `core.flow.humanApproval` suspend, real `Run.resume`, real `InMemoryStore` snapshot, C18 audit |
| `MastraCatalogueListing.test.ts` | `MastraGraphExecutionBackend` list/lookup | catalogue + C23 ownership filtering after real runs |
| `MastraCapabilities.test.ts` | `MastraCapabilities` | `MASTRA_FEATURE_CAPABILITIES` verdicts and backend projection |
| `MastraEngineHostConfig.test.ts` | `GraphExecutionEngine.initialize`, `MastraGraphExecutionBackend` config retention | host `backend.initialize({ mastra, stepHandlers, suspendStateReader })` before boot survives the facade merge; negative control fails closed `GRAPH_MASTRA_UNSUPPORTED_KIND` (SAA-312/SAA-315) |
| `MastraWorkflowManagement.test.ts` | `MastraWorkflowManager`, `MastraGraphExecutionBackend.management`, `MASTRA_FEATURE_CAPABILITIES` | real `addWorkflow`/`removeWorkflow`/`getWorkflow`/`listWorkflows`/`getWorkflowOrigin`, real `Workflow.serializedStepGraph`, create → list/get → edit → run → delete round-trip; fail-closed `GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE`/`GRAPH_MASTRA_WORKFLOW_NOT_FOUND`/`GRAPH_MASTRA_PERSIST_NOT_SUPPORTED` (SAA-346) |

#### Real vs host-injected

- **Real:** `@mastra/core` step/workflow construction, `createRun`, `stream` /
  `fullStream`, suspend and resume, `InMemoryStore` snapshots, and the real
  `Mastra` workflow registry (`addWorkflow`/`removeWorkflow`/`getWorkflow`/
  `listWorkflows`/`getWorkflowOrigin`) driving the SAA-346 management surface.
- **Host-injected (by design):** the frame-bound event sink (the engine normally
  creates it), the `MastraSuspendStateReader` port (Mastra owns the run snapshot),
  and `config.mastra` (a host accessor because the `Mastra` class exposes no public
  `getRun`).

#### Known integration seam

`GraphExecutionEngine.initialize` now preserves host-supplied backend configuration.
It merges the backend's retained config (`GraphExecutionBackend.config`) under the
facade-owned keys, so a host `backend.initialize({ mastra, stepHandlers })` performed
before `engine.boot(...)` survives the boot pass. The facade-owned keys `engine`,
`valueAdapter`, `codeSandboxEvaluator`, and `workflowStore` win on collision; every
other host key is preserved. Re-initializing the backend after boot is therefore no
longer needed (SAA-312 engine-seam fix). Covered by `MastraEngineHostConfig.test.ts`.

#### Workflow management surface (SAA-346)

`MastraWorkflowManager` (exposed as `MastraGraphExecutionBackend.management`) adds a
**full-control management surface over real Mastra workflows**, using only methods the
pinned `@mastra/core@1.74.0` genuinely exposes:

- **create** — compiles the canonical document through `MastraWorkflowCompiler` and
  registers the committed workflow on the wired `Mastra` instance (`addWorkflow`).
- **update/edit** — recompiles the updated canonical document and replaces the live
  registration (`removeWorkflow` then `addWorkflow`; the pinned library documents
  `removeWorkflow` as the update/delete path).
- **delete** — removes the live registration (`removeWorkflow`).
- **list / get** — reads the real Mastra registry (`listWorkflows` / `getWorkflow`),
  distinct from the engine-agnostic compiled-cache `listWorkflows`/`getWorkflow`.
- **serialize** — returns the real `Workflow.serializedStepGraph`.
- **revision** — the canonical document fingerprint; Mastra has no native workflow
  version, so the wrapper tracks the revision and the row is `EXTENSION-POINT`.
- **persist** — declared `NOT-SUPPORTED` and fails closed
  `GRAPH_MASTRA_PERSIST_NOT_SUPPORTED`: the real `addDynamicWorkflow` persists only
  agent/tool-referenced steps, while the canonical translation emits host code steps.

Every operation validates the runtime surface it needs first and fails closed with
`GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE` when the wired runtime omits the real
method; an unknown id fails closed `GRAPH_MASTRA_WORKFLOW_NOT_FOUND`. The
capability table (`MASTRA_FEATURE_CAPABILITIES`) and
`resolveMastraCapabilities()` gain honest rows (`workflowCreate`,
`workflowUpdate`, `workflowDelete`, `workflowRegistryList`,
`workflowRegistryLookup`, `workflowSerialize` = `SUPPORTED`; `workflowPersist` =
`NOT-SUPPORTED`; `workflowVersion` = `EXTENSION-POINT`), and the server manifest
(`src/nest/graph/GraphEngineCapabilityManifest.ts`) derives them from the table at
module load, so no `src/nest/graph/**` change is needed. for-angular consumes
the manifest as data only.

#### Management security hardening (SAA-353)

The SAA-347 review hardened the management surface (C3/C6/C7):

- **C3 — complete mediation of management mutations.** `create`/`update`/`delete`
  now accept the forwarded Decaf context and enforce `canAccessGraphResource` on the
  wrapper-recorded owner, and refuse to overwrite or delete any registration the
  wrapper did not create (including a host `origin: "code"` workflow), failing closed
  `GRAPH_MASTRA_WORKFLOW_FORBIDDEN`.
- **C6 — capability projection fails closed.** `mastraCapabilityStatusOf` now maps
  only an explicit `SUPPORTED` verdict to `supported`; a missing/renamed row or a
  `PARTIAL` verdict resolves to `not_supported` rather than silently `supported`.
- **C7 — the management surface is cached per backend.** `backend.management` now
  returns a stable `MastraWorkflowManager` (reset on `initialize`/`dispose`) so a
  revision recorded at `create` survives the next `management` access instead of being
  dropped by a fresh manager.

### Dagster driver integration suite

Location: `tests/integration/dagster/**` (sibling to `tests/integration/graph/**`).
These are **real** integration tests against a real `dagster-webserver` pinned at
`1.13.25` — the version recorded in `package.json` `dagster.pinnedVersion` and in
`src/dagster/constants.ts` `DAGSTER_PINNED_VERSION`. They never mock the Dagster
GraphQL API: the harness builds the pinned image, boots the webserver with the committed
example project, and drives the production read-only backend through a real thin GraphQL
client.

Run it (requires Docker and network access for the first image build):

```bash
npm run test:integration:dagster
```

`run.sh` builds `tests/integration/dagster/Dockerfile` (base `python:3.13-slim`,
`pip install dagster==1.13.25 dagster-webserver==1.13.25`), starts
`tests/integration/dagster/app/definitions.py` behind `dagster-webserver` **and a
`dagster-daemon`** (so runs launched through the webserver's GraphQL surface are
actually executed), executes `etl_pipeline` once at container startup so a
pre-existing run is visible, waits for `POST /graphql { version }`, runs Jest with
`DAGSTER_GRAPHQL_URL`, and removes the container on exit.

Equivalent direct invocation against an already-running gateway:

```bash
DAGSTER_GRAPHQL_URL=http://127.0.0.1:3300/graphql \
  npx jest --testPathPatterns="/tests/integration/dagster" --detectOpenHandles
```

- Self-contained: the image and example project are committed under
  `tests/integration/dagster/**`; deterministic ports (`DAGSTER_IT_PUBLISHED_PORT`,
  default `3300`), health-wait, and `trap`-based teardown.
- When the runner is itself inside a container sharing the Docker daemon, the harness
  starts the gateway in the runner's own network namespace
  (`--network container:$(hostname)`) and talks to it on `127.0.0.1:3000`; otherwise it
  publishes `127.0.0.1:3300`. Set `DAGSTER_GRAPHQL_URL` yourself to reuse a gateway.
- CI skip strategy (explicit, never a mock): if `DAGSTER_GRAPHQL_URL` is unset the
  suite is reported as **skipped** with the reason in the suite title. The green path is
  the `test:integration:dagster` script, which always boots the real gateway. There is no
  hand-mocked HTTP fallback.
- The suite also runs under `npm run test:integration` and `npm run test:all` when
  `DAGSTER_GRAPHQL_URL` is set; it is excluded from the default unit run.

#### Coverage

| Suite | Driver surface | Real engine evidence |
| --- | --- | --- |
| `DagsterReadOnlySurface.test.ts` | `DagsterGraphExecutionBackend`, `DAGSTER_CAPABILITY_TABLE`, `./dagster` barrel | real job listing, real op/dependency/asset/schedule/sensor inspection, authoring still rejected `GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED` |
| `DagsterRunVisibility.test.ts` | `DagsterGraphExecutionBackend` run/observe | real pre-existing run terminal record, real `eventConnection` replayed onto the canonical sink, `SUCCEEDED` result with per-op node results |
| `DagsterExecutionGate.test.ts` | `DagsterGraphExecutionBackend` execute/replay, `DAGSTER_CAPABILITY_TABLE` | gate OFF fails closed `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` with no network call; gate ON launches an already-deployed job through real `launchRun`, waits for terminal via `getRun`, and observes the completed run; `replayRun` re-executes an existing run through real `launchRunReexecution` and observes the new run |

#### Config-gated execution (SAA-345)

`DagsterGraphExecutionBackend` keeps its read-only surface and adds an
**explicitly config-gated** execution surface. `initialize` reads
`DagsterGraphExecutionBackendConfig.executionEnabled` (default `false`); when off,
`execute` and `replayRun` throw `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` **before any
client or network call**. When on, the driver requires the host port to expose
`launchRun`/`replayRun`; it launches an **already-deployed** job (`launchRun`) or
re-executes an **existing** run (`launchRunReexecution` via the port's `replayRun`),
then awaits the run's terminal state through the read-only `getRun` surface and
observes it through the existing `DagsterGraphEventBridge` to a canonical
`GraphExecutionResult`. It never emits Python and never authors a job, op, or
`launchRun`-of-a-translated-document; `GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED` still
guards that path. The capability table marks both new rows `SUPPORTED` with the
`executionEnabled` gate named.

#### Execution security hardening (SAA-353)

The SAA-347 security review found four defects on the gated surface; each is fixed
and covered by `tests/unit/graph/dagster/DagsterExecuteReplayExploit.test.ts` (SAA-352):

- **C1 — run↔workflow binding (replay BOLA).** `replayRun` now reads the source
  run through `getRun` and requires its owning job (`jobName`/`pipelineName`) to equal
  the requested workflow id, failing closed `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` when
  it differs or cannot be determined. A replay can never re-execute a foreign job's run.
- **C2 — launch job selection is never metadata-driven.** The canonical job is bound
  from the requested workflow id (`document.id || document.name`) and resolved with
  `getJob`; a document whose `metadata.dagsterJobName` names a different job is
  rejected `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` before any launch.
- **C5 — terminal-status fail-closed.** Only `success`/`failure`/`canceled` are
  terminal; the real pending statuses `QUEUED`/`STARTING` are polled to terminal, a
  caller abort (`GRAPH_DAGSTER_OBSERVE_ABORTED`), or the timeout
  (`GRAPH_DAGSTER_OBSERVE_TIMEOUT`) instead of being read as a terminal result.
- **C4 — run-config disclosure and shape.** The optional `metadata.dagsterRunConfig`
  object is forwarded as Dagster `runConfigData`, but only after an allowlist validates
  it as a JSON-safe value tree (`GRAPH_DAGSTER_RUN_CONFIG_INVALID` otherwise); the
  capability rows now name this forwarding so callers see it in the manifest.

#### Real vs host-injected

- **Real:** the pinned `dagster-webserver` GraphQL API, the example deployment's
  jobs, ops, dependencies, asset keys, schedules, sensors, and the pre-existing
  `etl_pipeline` run and its recorded event stream.
- **Harness transport (by design):** `DagsterGraphQLClient` implements the production
  `DagsterClient` port over the live GraphQL API; `RecordingSink` is the facade-owned
  event sink the driver reports transitions through. Neither substitutes a mock.

#### Harness findings (reported production addition)

The real run stream exposed a bridge defect: `DagsterGraphEventBridge` maps
`RUN_START → WORKFLOW_STARTED` but dropped it, because the run-level event carries no
`stepKey` and the bridge required a resolved node id. `observeRun` therefore never emitted
`WORKFLOW_STARTED`. Fixed in `src/dagster/DagsterGraphEventBridge.ts`: a non-terminal
run-level event with no step key now emits without a node id, while a step event with an
unknown key is still ignored (unchanged). Covered by the integration suite; the security
re-review gate covers the diff.

#### Transport caveat

Dagster's GraphQL `ExecutionStepOutputEvent` exposes the output name but not the
materialized value, and `Run` exposes no run outputs. The transport records the output
name as the `STEP_OUTPUT` payload marker and returns `{}` outputs; the suite asserts
event/node visibility, not materialized values.
