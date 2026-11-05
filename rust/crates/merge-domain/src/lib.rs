//! `@weldsuite/merge-domain`: the WeldMerge code another module shares.
//!
//! - [`installations`]: recording a GitHub App installation as a WeldMerge
//!   connection (`merge_connections`) and its row in the master
//!   `merge_provider_index`, its status, and its removal. WeldMerge's setup
//!   route and installation events and WeldConnect's install callback,
//!   recover and disconnect all go through it, so the install paths cannot
//!   drift (ADR MERGE-002).

pub mod installations;
