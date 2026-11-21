//! The master and tenant databases as SeaORM entities: one module per table,
//! with the row's Rust types, its JSON shape (as Drizzle returned it) and the
//! table's definition (`DDL`).
//!
//! Until the flip (weldsuite-documentation
//! `plans/rust-schema-orm-and-migrations.md`), `tenant/` and `master/` are
//! generated from the Drizzle schema by `pnpm rust:schema`; don't edit them.

#![allow(clippy::doc_markdown, clippy::too_many_lines)]

pub mod ddl;
pub mod js;

#[rustfmt::skip]
#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod master;

#[rustfmt::skip]
#[allow(unreachable_pub, clippy::all, clippy::pedantic)]
pub mod tenant;
