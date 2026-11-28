# Rust backend (`rust/`)

WeldSuite's backend (ADR API-014): one `weldsuite` binary, shipped as one
container image and installed with the Helm chart in `deploy/helm/weldsuite`,
for the hosted EU install and for self-hosted installs. Global's TypeScript
workers, which it was ported from, were deleted after Global retired (ADR
OPS-025), so this is the only backend.
Read the root `AGENTS.md` first. [`README.md`](README.md) here is the full
reference (layout, commands, migrations, running it); read the section you
need rather than all of it.

## Rules

- **Routes keep their contract.** The platform, the mobile apps, the SDKs and
  the public API call these paths with these bodies; a route's tests are its
  contract now that there is no TypeScript twin to compare against. Change an
  answer the native apps read only as `apps/mobile-shared/README.md` says
  ("Changing the contract").
- **Part of `catalogs/` is generated from TypeScript.** After changing entity
  events, permissions, feature flags, the AI catalog, the forms templates or
  the WeldConnect templates, run `pnpm rust:catalogs` and commit the result;
  `pnpm rust:emails` and `pnpm rust:payroll-fixtures` do the same for the email
  templates and the payroll tables. The catalogs only the backend reads
  (`api-modules.json`, `record-chat.json`, `core-platform-prefixes.json`,
  `first-party-origins.json`, `connectors.json`, `odata.json`, WeldConnect's
  pickers and providers in `weldconnect.json`) are edited here by hand, as are
  the fixtures the deleted workers once wrote.
- **Module crates never depend on each other**, only on shared crates.
- Lints are workspace-wide: `unsafe` is forbidden, clippy pedantic is on,
  warnings are errors. Every crate has `[lints] workspace = true`; dependency
  versions live in `[workspace.dependencies]`.
- A new licence in `deny.toml` is a licensing decision (the backend is
  AGPL-3.0-only); say why in the PR.
- Bumping the toolchain is its own PR: `rust-toolchain.toml` and
  `rust-version` in `Cargo.toml` together.
- **The schema is the entities in `crates/schema`** (ADR DATA-019). A schema
  change edits them; the migration is generated into `migrations/` with
  `pnpm db:generate --name <slug>` (`db:generate:master`), and only with a
  person's approval. Migrations are embedded in the binary. EU production
  deploys every green `main` build, so keep them additive.
- **New queries go through the SeaORM entities** (`weldsuite_db::orm`,
  `OrmConn` inside `atomically_with`; README "Queries"). Raw `sqlx::query*`
  is a clippy error except in the crates listed in
  `crates/schema/tests/raw_sql.rs`, which only shrinks: never add a crate or a
  crate-level `allow`. SQL that stays SQL gets
  `#[allow(clippy::disallowed_methods, reason = "…")]` on its function.

## Commands

From the repo root:

```bash
pnpm rust:fmt
pnpm rust:lint          # rustfmt --check + clippy, warnings are errors
pnpm rust:test
pnpm rust:deny          # needs cargo-deny
pnpm rust:catalogs      # re-export the TypeScript-owned catalogs
```

Integration tests need throwaway services (Postgres, Valkey, NATS, S3, …) and
are skipped without them; the variables are listed in the README. CI's
`Rust` check aggregates `Rust · checks`, `Rust · image and chart`,
`Rust · image arm64` and `Rust · deploy config`.
