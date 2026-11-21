//! The master and tenant databases as SeaORM entities: one module per table,
//! with the row's Rust types, its JSON shape (as Drizzle returned it) and
//! what the entity can't say about the table (`DDL`). `tenant::snapshot()`
//! and `master::snapshot()` put the two together as the drizzle-kit snapshot
//! migrations are diffed against (ADR DATA-019).
//!
//! The entities are the schema's source. To change it, edit them and run
//! `pnpm db:generate` (or `db:generate:master`), which writes the migration
//! to `rust/migrations` from the difference. A new table is a module with its
//! `Model` and `DDL`, a `pub mod` line and an entry in `tables()` in its
//! database's `mod.rs`; a new Postgres enum goes in `enums.rs` and its
//! `all()`. `tests/snapshot.rs` fails while the entities and the newest
//! migration's snapshot disagree.

#![allow(clippy::doc_markdown, clippy::too_many_lines)]

pub mod ddl;
pub mod js;
pub mod snapshot;

#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod master;

#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod tenant;
