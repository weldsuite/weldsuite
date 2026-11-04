//! WeldFlow's domain rules (`packages/domains/flow`, `@weldsuite/flow-domain`)
//! that more than the flow module needs: mcp-server, external-api,
//! sheets-api, connect-api and workflow-worker import them in TypeScript.
//! Route-only code stays in `rust/modules/flow`.

pub mod acceptance;
pub mod access;
pub mod analytics;
pub mod approval_views;
pub mod approvals;
pub mod baselines;
pub mod benefit_metrics;
pub mod benefits;
pub mod blueprint;
pub mod capacity;
pub mod changes;
pub mod day_bounds;
pub mod decisions;
pub mod deliverables;
pub mod finance;
pub mod gates;
pub mod intake;
pub mod js;
pub mod numbering;
pub mod project_closing;
pub mod project_portal;
pub mod project_templates;
pub mod raid;
pub mod recurrence;
pub mod risk;
pub mod schedule;
pub mod scope;
pub mod stage;
pub mod stakeholders;
pub mod stats;
pub mod status_report;
pub mod task_dependencies;
pub mod task_relations;
pub mod task_tree;
pub mod tasks;
