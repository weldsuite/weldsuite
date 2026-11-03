//! WeldFlow's domain rules (`packages/domains/flow`, `@weldsuite/flow-domain`)
//! that more than the flow module needs: mcp-server, external-api,
//! sheets-api, connect-api and workflow-worker import them in TypeScript.
//! Route-only code stays in `rust/modules/flow`.

pub mod access;
pub mod analytics;
pub mod approvals;
pub mod day_bounds;
pub mod gates;
pub mod js;
pub mod numbering;
pub mod raid;
pub mod recurrence;
pub mod risk;
pub mod schedule;
pub mod stage;
pub mod stats;
pub mod task_dependencies;
pub mod task_relations;
pub mod task_tree;
pub mod tasks;
