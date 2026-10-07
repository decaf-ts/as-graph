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

#### Real vs host-injected

- **Real:** `@mastra/core` step/workflow construction, `createRun`, `stream` /
  `fullStream`, suspend and resume, and `InMemoryStore` snapshots.
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
`tests/integration/dagster/app/definitions.py` behind `dagster-webserver`, executes
`etl_pipeline` once at container startup so a pre-existing run is visible, waits for
`POST /graphql { version }`, runs Jest with `DAGSTER_GRAPHQL_URL`, and removes the
container on exit.

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
| `DagsterReadOnlySurface.test.ts` | `DagsterGraphExecutionBackend`, `DAGSTER_CAPABILITY_TABLE`, `./dagster` barrel | real job listing, real op/dependency/asset/schedule/sensor inspection, authoring rejected `GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED` |
| `DagsterRunVisibility.test.ts` | `DagsterGraphExecutionBackend` run/observe | real pre-existing run terminal record, real `eventConnection` replayed onto the canonical sink, `SUCCEEDED` result with per-op node results |

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
