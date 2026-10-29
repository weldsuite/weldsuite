# Porting a TypeScript route group to Rust

How the know and sign ports were done, as rules for the next one. The phase
plan and the playbook steps live in the docs repo
(`design/platform/editions-and-self-hosting-phases.md`, "Module port
playbook"); this file is the how-to. Worked examples: `rust/modules/know`
(small, DB + events) and `rust/modules/sign` (files, Drive access, multipart,
templates).

## Layout

- One crate per ported `weld*` module or core area: `rust/modules/<name>`
  (package `weldsuite-<name>`), added to `[workspace.dependencies]` in
  `rust/Cargo.toml` and to `bins/weldsuite/Cargo.toml`. `modules/*` is
  already a workspace member glob.
- `lib.rs` exposes `pub struct <Name>State { .. }` (the ports it needs, cloned
  from `AppState`) and `pub fn router<S, Q>(state, gate: &Arc<PermissionGate<Q>>) -> Router<S>`
  with paths relative to the module's prefix. `bins/weldsuite/src/routes/mod.rs`
  nests it behind `mounts("<module id>")`, so it is served once the module is
  in `RUST_PORTED_MODULES` and always in conformance builds.
- Core platform areas (app-api) use the module id `core`; nest them at their
  own prefixes in `routes/mod.rs` the same way, behind
  `cfg!(feature = "conformance") || <flag>` until they are complete.

## Handlers

- A `Caller` extractor (see `modules/sign/src/lib.rs`) built from the request
  extensions: `AuthContext`, `Tenant`, `Permissions`, `EventContext`, and the
  request overrides conformance inserts (`weldsuite_kit::RequestEnv`,
  `weldsuite_ports::FileStores`, `weldsuite_db::MasterDb`). Prefer the
  override, fall back to the state.
- `requirePermission(key)` is `.route_layer(gate.require([key]))` on that
  method's route. Two `requirePermission` in a row: the one TS checks first is
  the outer layer (added last). Different permissions per method on one path:
  add the path twice, one `MethodRouter` each (axum merges them).
- `hasContextPermission(c, key)` is `caller.permissions.has_any(&[key])`.
- `zValidator('json', schema)` runs before the handler body and after the
  permission gates: read the body with `weldsuite_kit::validation`
  (`Issues::text_with`, `choice`, `boolean`, `number`/`whole_number`,
  `nested`, `list`, `item_text`, `records`) in the schema's field order, with
  `Presence` matching `.optional()`/`.nullable()`/`.nullish()` (a `.partial()`
  of a nullable field is nullish). `zValidator('query', …)` reads
  `query_values(raw_query)`; `z.coerce.number()` is `Number { coerce: true }`.
  Add a missing rule to the validator with a test against Zod's real output
  (run Zod from `packages/clients/app-api-client` and paste its issues).
  `.min().max().regex(re, msg)` is `Issues::pattern` (Zod checks in that
  order). A `.refine()` is `Issues::custom`, called after every other field:
  `zValidator` uses `safeParseAsync`, which settles refinements after the
  body's synchronous checks, so their issues come last.
- JavaScript key order: `serde_json` sorts object keys, but `JSON.stringify`
  comparisons (`computeChanges`), `asText` of an object and "the first
  invalid field" all follow the body's order, and a `jsonb` column comes back
  in `jsonb`'s (shorter keys first). `modules/core-objects/src/js.rs` keeps
  either order and prints values and numbers as JavaScript does.
- Errors: mirror the route's own mapping (`respondToSignError`,
  `accessError`, …) in one enum with a `respond()`; unknown errors are a 500
  through `ApiError::internal()` (with the route's message where TS passes
  one). Not-found messages: `ApiError::not_found(resource, id)` matches
  `error.notFound(c, resource, id)` byte for byte.
- Entity events: `publish_entity_event` with the catalog constant
  (`weldsuite_catalogs::entity_events::*`) and exactly the TS `data` object.
- Fire-and-forget work (`waitUntil`) runs on `state.events.tracker()`.
- Routes the worker mounts ahead of `clerkMiddleware`, because they check
  their own credential (an upload token, a files cookie, a signed URL): the
  module exposes a second router at their full `/api/...` paths
  (`core_files::storage_public_router`), and `routes::public` merges it into
  the root router in `server.rs`, outside the session and tenant layers.
  Conformance builds give those routes only what the test shares (its env,
  buckets, KV, and a `SessionVerifier` for its own `CLERK_JWT_KEY`), through
  `conformance::public`.

## SQL

- sqlx only takes literal SQL: no strings built at run time. Optional
  filters are `($n::text is null or col = $n)`; partial updates are
  `col = case when $set then $value else col end` per field; lists use
  `= any($n)`; multi-row inserts use `unnest($1::varchar[], …)` (one
  statement, like Drizzle's, so rows share `created_at`).
- Rows: `select to_jsonb(t) …` then `weldsuite_db::js_row` gives Drizzle's
  camelCase keys and `toISOString()` timestamps. Hand-picked DTOs: build a
  `json!` with the same keys, from that row (`pick` helper in sign).
- Timestamps written by the route (`new Date()`): bind
  `weldsuite_events::iso_timestamp(now)` as text with `::timestamptz` (or
  `::timestamp` for columns without a zone). Columns the route leaves to the
  database default stay out of the insert.
- Numbers that end up in `jsonb`: write integral values as integers (`612`,
  not `612.0`), since jsonb keeps the scale.
- Mirror ordering exactly (`order by`), including the tie-breaker; where TS
  has no `order by`, do not add one.
- JavaScript semantics: `??` (null/undefined) vs `||` (also empty string);
  `if (x)` on strings treats `''` as false; `Math.round` is
  `(n * 100 + 0.5).floor()`; string lengths are UTF-16 units.

## Conformance

1. Inventory the routes (`pnpm rust:conformance --coverage apps/workers/<worker>`
   shows which routes the worker's tests reach) and add pglite tests
   (`createPgliteDb`, never `createMockDb`) for every route not reached,
   including refusals. They must pass on TypeScript first.
2. Response schemas: every route with a body needs a Zod schema registered in
   `packages/core/worker-kit/src/testing/conformance-schemas.ts`. Where the
   clients only have interfaces, add schemas to the client package matching
   those interfaces.
3. Add the suite to `rust/conformance/suites.json` (the worker's test files
   and the paths that change it). Once the module is in
   `RUST_PORTED_MODULES`, an unreached route fails the suite.
4. Run it: build the conformance server and run the tests with
   `CONFORMANCE_TARGET=rust CONFORMANCE_STRICT=0 CONFORMANCE_REPORT_DIR=<dir>`
   (`pnpm rust:conformance` does the whole thing; `--no-build` reuses the
   binary). Every request runs on both backends: a read on the shared pglite,
   a write on TypeScript first, on a copy of the database and copy-on-write
   views of the buckets and KV (`write-isolation.ts`), then on Rust with the
   real ones, so both start from the same state and the test's assertions
   see Rust's writes. Status, body, schema and side effects (entity events,
   realtime, outbound calls) must match. A write's body is compared with what
   differs by construction between two runs normalised (`normalizeForDiff`):
   new ids, timestamps, cursors, a `Date.now()` inside a string, upload
   tokens and an upload key's random segment, and what a signing route
   derives from the current second (an `expiresAt` within two days of now, a
   signed URL's `exp` and `sig`). Rust's signature is still checked: the
   reads that redeem it run on both backends.
5. Third-party APIs (Clerk's Backend API today) are ports
   (`weldsuite_ports::Identity`). In conformance mode Rust's calls go through
   the harness's outbound bridge (`outbound-bridge.ts`,
   `conformance_outbound.rs`) into the test's own `fetch` stub, and the calls
   both backends made are compared as a side effect (method, URL, body). A
   stub answers both runs, so it must answer by URL and method
   (`mockImplementation`), never by call order (`mockResolvedValueOnce`).
6. Routes that write the master database: put `masterDb` (from
   `createMasterPgliteDb()`) in the test context and mock `getMasterDb` to
   return `conformanceMasterDb(masterDb)` (from
   `@weldsuite/worker-kit/testing/conformance`). On a write the TypeScript
   run then reads a copy of the master taken before either run, as it does
   for the tenant database.
7. The harness shares what a test sets up: the tenant pglite, `masterDb` from
   the test context, R2-shaped buckets in `env` (served over HTTP), and the
   forwarded env values (`FORWARDED_ENV` in `conformance.ts`; add a secret the
   routes read there). A test that mocks something the harness can't see
   (a `vi.mock` of `getMasterDb`) needs the value in its context too.
8. Workers KV is shared the same way. A KV-shaped binding in the test's
   `env` (`get`/`put`/`delete`; the names in `KV_BINDINGS`, today
   `WORKSPACE_CACHE`) is served over HTTP by
   `packages/core/worker-kit/src/testing/kv-bridge.ts`: `GET /value?key=…`
   (the value as text, 404 when missing), `PUT /value?key=…&ttl=<seconds>`
   (`expirationTtl`; left out for no expiry), `DELETE /value?key=…`. Its URL
   travels in the context's `kv` (`{ WORKSPACE_CACHE: url }`), and
   conformance builds insert a `weldsuite_ports::RequestCache` over it
   (`bins/weldsuite/src/conformance_kv.rs`). A module that reads the cache
   takes the request's `RequestCache` first and its state's cache
   otherwise, as it does with `FileStores`. Another namespace needs its name
   in `KV_BINDINGS` and in `KvBridges::request_cache`.
9. Database errors work as they do on Postgres: a route may hit a unique
   violation or any other failing statement, and later requests in the same
   file still run on the same connection. Port the TypeScript behaviour
   as it is (a plain insert that fails, not an `on conflict do nothing`
   stand-in), and keep such tests where they belong in the file. pglite 0.4
   answers a failed extended-protocol message with an extra ReadyForQuery,
   which put sqlx's connection out of step; the harness serves pglite
   through `wireCompatiblePglite` (`packages/core/worker-kit/src/testing/pglite-wire.ts`),
   which drops it, so each Sync gets exactly one.

## Jobs, crons and generated files

- A Workflow is a `Job` (`weldsuite_ports::jobs`) named `<module>.<job>`,
  registered in `bins/weldsuite/src/routes/mod.rs` where the module's state is
  built; one run per key (the Workflow instance id), one `step` per `step.do`
  with its retries. Conformance builds run jobs in the process, on the tracker
  `/__conformance/side-effects` waits for.
- A Workflow that opens with `step.sleepUntil(date)` is a delayed start, at
  the `create()` call that TypeScript makes: `JobRequest::with_delay` /
  `starting_at`. Restate holds the invocation durably until it is due; the
  in-process adapter waits in a task, and a restart loses it.
  `core_files::TrashPurgeJob` (the 30-day trash purge) is the example.
- A Cron Trigger is a `weldsuite cron <name>` subcommand
  (`bins/weldsuite/src/cron.rs`) and an entry in the chart's `cron.jobs`. A
  due-index sweep uses `weldsuite_db::due_index::run_sweep` (rows keyed by
  `workspaces.id`, not the Clerk org id).
- A cron test calls the job's function, not a route: wrap the call in
  `conformanceSweep` (`worker-kit/src/testing/conformance-cron.ts`) and serve
  the job at `/__conformance/cron/<name>` (`bins/weldsuite/src/conformance.rs`).
  It compares the result, events, mail and due index.
- Output that can't be byte for byte the same (the signed PDF: pdf-lib vs
  `lopdf`): test what it contains against fixtures the TypeScript code wrote
  (`modules/sign/tools/pdf-fixtures.mts`), and normalise only the values
  derived from the bytes (the hash) in `normalizeForDiff`, with a comment.

## Checks before a commit

`cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
the same with `-p weldsuite --features conformance`, `cargo test --workspace`
(DB tests run with `WELDSUITE_TEST_MASTER_URL`/`WELDSUITE_TEST_TENANT_URL`
from `scripts/rust-test-db.ts` on a `pgvector/pgvector:pg17` container), the
worker's own tests on TypeScript, Sonar on changed TS
(`npx eslint -c eslint.sonar.config.mjs <files>`), and the conformance run.
Never create a database migration without the user's approval.
