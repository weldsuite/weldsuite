# Rust backend (`rust/`)

The backend of the EU and self-hosted editions (ADR API-014): one `weldsuite`
binary, shipped as one container image and installed with the Helm chart in
`deploy/helm/weldsuite`. Global keeps the TypeScript workers on Cloudflare;
modules are ported from them one at a time, and both answer the same API.
Read the root `AGENTS.md` first. [`README.md`](README.md) here is the full
reference (layout, commands, conformance, migrations, running it); read the
section you need rather than all of it.

## Rules

- **A ported route answers exactly like its TypeScript route**: path, body,
  status, message and side effects (entity events, realtime). The conformance
  suite (`conformance/suites.json`, `pnpm rust:conformance`) is the judge, and
  CI runs it on every PR that touches the module. So a behaviour change to a
  ported route lands in TypeScript and Rust in the same PR.
- **A module is ported** when its suites pass with every route covered; then
  its id goes into `RUST_PORTED_MODULES` in `@weldsuite/api-modules` and you
  run `pnpm rust:catalogs`.
- **`catalogs/` is generated from TypeScript.** After changing entity events,
  permissions, feature flags, `api-modules` or `FIRST_PARTY_ORIGINS`, run
  `pnpm rust:catalogs` and commit the result. The `rust:*-fixtures` scripts
  re-export parity fixtures the same way.
- **Module crates never depend on each other**, only on shared crates.
- Lints are workspace-wide: `unsafe` is forbidden, clippy pedantic is on,
  warnings are errors. Every crate has `[lints] workspace = true`; dependency
  versions live in `[workspace.dependencies]`.
- A new licence in `deny.toml` is a licensing decision (the backend is
  AGPL-3.0-only); say why in the PR.
- Bumping the toolchain is its own PR: `rust-toolchain.toml` and
  `rust-version` in `Cargo.toml` together.
- Migrations are the same journaled Drizzle SQL the TypeScript runners apply,
  embedded in the binary. EU production deploys every green `main` build, so
  keep them additive.

## Commands

From the repo root:

```bash
pnpm rust:fmt
pnpm rust:lint          # rustfmt --check + clippy, warnings are errors
pnpm rust:test
pnpm rust:deny          # needs cargo-deny
pnpm rust:catalogs      # re-export catalogs/ from TypeScript
pnpm rust:conformance   # the ported routes' worker tests, run against Rust
```

Integration tests need throwaway services (Postgres, Valkey, NATS, S3, …) and
are skipped without them; the variables are listed in the README. CI's
`Rust` check aggregates `Rust · checks`, `Rust · image and chart`,
`Rust · deploy config` and `Rust · conformance`.
