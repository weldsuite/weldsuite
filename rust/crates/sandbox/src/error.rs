//! Why a sandbox call failed.

use std::fmt;

/// Why a sandbox, its agent or the search engine did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    /// The install has no sandbox (`SANDBOX_ENABLED` is off).
    Disabled,
    /// The isolation check reached what a sandbox must never reach (the
    /// metadata service, the Kubernetes API, …): the cluster does not enforce
    /// the sandbox's network policy. No sandbox is handed out.
    NotIsolated(Vec<String>),
    /// The workspace already runs its maximum of sandboxes.
    WorkspaceLimit(usize),
    /// The install runs its maximum of sandboxes.
    InstallLimit(usize),
    /// The pod did not start (image pull, scheduling, a refused spec).
    StartFailed(String),
    /// The pod or its agent did not answer in time.
    Timeout(&'static str),
    /// The Kubernetes API refused (status, its message).
    Kube(u16, String),
    /// The agent in the pod refused (status, its message).
    Agent(u16, String),
    /// The pod, the API or the search engine could not be reached.
    Unreachable(String),
    /// A call this crate refuses before sending it (a bad URL, a bad path).
    Invalid(String),
}

impl SandboxError {
    /// The sentence the model gets as the tool's error. Never the cluster's
    /// internals: an operator reads those in the logs.
    pub fn for_model(&self) -> String {
        match self {
            Self::Disabled => "The sandbox is not available on this installation.".to_owned(),
            Self::NotIsolated(_) => {
                "The sandbox is switched off: its network isolation could not be verified. \
                 Ask an administrator to check the installation."
                    .to_owned()
            }
            Self::WorkspaceLimit(limit) => format!(
                "This workspace already runs {limit} sandboxes. Try again when another agent \
                 conversation has finished."
            ),
            Self::InstallLimit(_) => {
                "Every sandbox is in use right now. Try again in a few minutes.".to_owned()
            }
            Self::StartFailed(_) | Self::Kube(..) | Self::Unreachable(_) => {
                "The sandbox could not be started. Try again in a moment.".to_owned()
            }
            Self::Timeout(what) => format!("The sandbox took too long ({what})."),
            Self::Agent(_, message) | Self::Invalid(message) => message.clone(),
        }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disabled => f.write_str("the sandbox is off (SANDBOX_ENABLED)"),
            Self::NotIsolated(reached) => write!(
                f,
                "a sandbox reached {} — the network policy of the sandbox namespace is not \
                 enforced (is a NetworkPolicy controller running?)",
                reached.join(", ")
            ),
            Self::WorkspaceLimit(limit) => write!(f, "the workspace runs {limit} sandboxes"),
            Self::InstallLimit(limit) => write!(f, "the install runs {limit} sandboxes"),
            Self::StartFailed(why) => write!(f, "the sandbox did not start: {why}"),
            Self::Timeout(what) => write!(f, "timed out: {what}"),
            Self::Kube(status, message) => write!(f, "kubernetes API {status}: {message}"),
            Self::Agent(status, message) => write!(f, "sandbox agent {status}: {message}"),
            Self::Unreachable(why) => write!(f, "unreachable: {why}"),
            Self::Invalid(why) => write!(f, "refused: {why}"),
        }
    }
}

impl std::error::Error for SandboxError {}
