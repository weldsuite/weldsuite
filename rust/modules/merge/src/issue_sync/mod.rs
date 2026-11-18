//! Two-way issue sync between WeldMerge issues and provider issues (GitHub
//! and GitLab, `services/issue-sync/*`; spec: weldsuite-documentation/plans/
//! weldmerge-phases-2-5.md, phase 2).
//!
//! The engine never talks to a provider directly: it calls the issue adapter
//! of [`crate::providers`] (`list_issues`, `create_issue`, `update_issue`,
//! `create_comment`) in the neutral `NormalizedIssue` shapes.
//!
//! - provider → WeldMerge is [`inbound`] (webhooks, imports);
//! - WeldMerge → provider is [`outbound`], driven by [`hooks`] and the
//!   explicit [`routes`];
//! - the loop guard and the status mapping are [`fields`];
//! - labels and assignees are [`people`].

pub(crate) mod fields;
pub(crate) mod hooks;
pub(crate) mod inbound;
pub(crate) mod outbound;
pub(crate) mod people;
pub(crate) mod routes;
pub(crate) mod targets;
