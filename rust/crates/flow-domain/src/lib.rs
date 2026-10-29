//! WeldFlow's domain rules (`packages/domains/flow`, `@weldsuite/flow-domain`)
//! that more than the flow module needs: mcp-server, external-api,
//! sheets-api, connect-api and workflow-worker import them in TypeScript.
//! Route-only code stays in `rust/modules/flow`.

pub mod access;
pub mod js;
pub mod numbering;
pub mod stage;
pub mod stats;
