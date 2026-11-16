//! WeldAgent's sandbox on the Kubernetes editions (ADR AI-012 phase 5,
//! `weldsuite-documentation/plans/eu-ai-mistral.md`, "The EU sandbox").
//!
//! On Global, Claude Managed Agents run an agent's sandbox (`computer:use`)
//! and its web tools (`browser:use`) at Anthropic, and agent-runtime runs its
//! browser on Cloudflare (`packages/domains/agent/src/computer-client.ts`).
//! Here they run on the install's own cluster:
//!
//! - **Sandbox pods** ([`kube`], [`service`]): one per agent conversation or
//!   run, in their own namespace (`weldsuite-sandbox`), under gVisor, with no
//!   service-account token, a network policy that lets them reach only the
//!   public internet, CPU, memory and disk limits, an idle timeout and a hard
//!   lifetime. The server creates and deletes them through the Kubernetes
//!   API with a service account that may touch only pods in that namespace.
//! - **The agent in each pod** ([`agent`], `rust/deploy/sandbox`): commands,
//!   files, code, page fetches, a Chromium for the browser tools and an X
//!   desktop for computer use, behind a per-pod token ([`token`]).
//! - **Web search** ([`search`]): the cluster's own `SearXNG`; only the query
//!   leaves the cluster.
//! - **The tools** ([`tools`]), which `weldsuite-agent` registers behind the
//!   existing grants.
//! - **Fail closed**: the first sandbox of a process checks that it can't
//!   reach the cloud metadata service or the Kubernetes API before any
//!   sandbox is handed out ([`Sandboxes::acquire`]).

pub mod agent;
pub mod config;
pub mod error;
pub mod fake;
pub mod kube;
pub mod sanitize;
pub mod search;
pub mod service;
pub mod session;
pub mod token;
pub mod tools;

pub use config::SandboxConfig;
pub use error::SandboxError;
pub use kube::{KubePods, PodApi, PodInfo};
pub use service::{CleanupReport, Sandbox, Sandboxes};
pub use session::SessionKey;
pub use tools::{Image, SandboxToolSpec, ToolOutput};
