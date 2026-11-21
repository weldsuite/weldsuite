//! WeldPanel's query layer for the Kubernetes editions: the Rust port of
//! `@weldsuite/panel-domain/query` (`packages/domains/panel/src/query`, ADR
//! PANEL-003). A typed spec goes in, SQL statements for Basin SQL (Apache
//! DataFusion) come out, and the rows the engine answers become the typed
//! result the platform draws.
//!
//! The SQL is byte for byte what the TypeScript compiler writes: the SQL
//! corpus (`packages/domains/panel/src/query/__corpus__/sql-corpus.json`)
//! holds every statement the TypeScript writes with its input, and
//! `tests/corpus.rs` compiles every input again and compares. So every place
//! the TypeScript leans on JavaScript (how numbers print, `Date` arithmetic,
//! `Intl` time zones, `Map` and `Set` order) does the same here ([`js`]).
//!
//! Layout, one module per TypeScript file:
//!
//! - [`schemas`]: the spec, definition and result shapes of
//!   `@weldsuite/app-api-client/schemas/weldpanel-{query,collab,analysis}`,
//!   as their Zod schemas parse them (defaults filled in). Refinements of
//!   raw API input (Zod issues) are the routes' job.
//! - [`query`]: the compiler (`sql`, `scope`, `time`, `paths`,
//!   `breakdowns`, one module per report kind), the runner (`rows`,
//!   [`query::run_panel_query`]), the cache key, the raw reads (`activity`,
//!   `export`) and root cause (`explain`).
//! - [`expression`]: trend formulas and computed properties.
//! - [`tables`], [`wire`], [`device_class`]: the constants the compiler reads.

// The compiler mirrors JavaScript arithmetic on doubles (casts between f64
// and integers, exact float comparisons) and long TypeScript functions one
// for one.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::float_cmp,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::option_option,
    clippy::struct_excessive_bools,
    clippy::similar_names
)]

pub mod device_class;
pub mod expression;
pub mod js;
pub mod query;
pub mod schemas;
pub mod tables;
pub mod wire;
