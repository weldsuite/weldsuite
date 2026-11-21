//! The master and tenant databases as SeaORM entities: one module per table,
//! with the row's Rust types, its JSON shape (as Drizzle returned it) and
//! what the entity can't say about the table (`DDL`). `tenant::snapshot()`
//! and `master::snapshot()` put the two together as the drizzle-kit snapshot
//! migrations are diffed against (ADR DATA-019).
//!
//! Until the flip (weldsuite-documentation
//! `plans/rust-schema-orm-and-migrations.md`), `tenant/` and `master/` are
//! generated from the Drizzle schema by `pnpm rust:schema`; don't edit them.

#![allow(clippy::doc_markdown, clippy::too_many_lines)]

pub mod ddl;
pub mod js;
pub mod snapshot;

#[rustfmt::skip]
#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod master;

#[rustfmt::skip]
#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod tenant;
