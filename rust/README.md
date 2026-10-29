# WeldSuite Rust backend

The backend that today's TypeScript workers are ported to, module by module
(ADR API-014). It builds one binary, `weldsuite`, shipped as one container image
that runs in all three deployments: Global (Cloudflare Containers), EU and
self-hosted (Kubernetes). The design, the decisions and the phase plan live in
the private docs repo: `design/platform/editions-and-self-hosting.md` and
`editions-and-self-hosting-phases.md` in `weldsuite/weldsuite-documentation`.

Status: **phase P1** (foundations). `crates/kit` holds the response envelope,
errors, ids, CORS and request ids. The binary only prints its version; `ports`,
`db`, auth and the request pipeline come next.

## Layout

```
rust/
  Cargo.toml            workspace: shared package metadata, lints, dependency versions
  rust-toolchain.toml   pinned compiler (CI and local builds use the same one)
  deny.toml             cargo-deny: allowed licences, advisories, sources
  clippy.toml           clippy settings (product names allowed in docs)
  bins/weldsuite/       the one binary (serve, consume, cron, migrate, admin commands)
  crates/kit/           response envelope, errors, ids, CORS, request id (worker-kit in TS)
  crates/               more library crates in P1: ports, adapters, db, then modules/<module>
```

## Commands

From the repo root:

```bash
pnpm rust:fmt     # format
pnpm rust:lint    # rustfmt --check + clippy, warnings are errors
pnpm rust:test    # tests
pnpm rust:deny    # licences, advisories, duplicate crates, sources (needs cargo-deny)
```

Or `cargo …` inside `rust/`. The pinned toolchain installs itself through rustup
on first use. `cargo install cargo-deny --locked` for the deny check.

## Rules

- **Lints are workspace-wide** (`[workspace.lints]` in `Cargo.toml`): `unsafe`
  is forbidden and clippy's pedantic group is on. Every crate opts in with
  `[lints] workspace = true`.
- **Dependency versions live in `[workspace.dependencies]`**; crates use
  `dep = { workspace = true }`.
- **A new licence in `deny.toml` is a licensing decision.** The backend ships
  under AGPL-3.0-only (OPS-002); say why in the PR.
- **Module crates never depend on each other**, only on shared crates. This is
  how the module boundaries of API-004 are enforced in Rust.
- **Bumping the toolchain** is its own PR: `rust-toolchain.toml` and
  `rust-version` in `Cargo.toml` together.
