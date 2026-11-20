//! Which sandbox a tool call uses: one per agent conversation (a chat keeps
//! its files and browser between turns) or per run (a manual run, an event,
//! a routine, a room reply), never shared between workspaces or agents.

use sha2::{Digest, Sha256};

/// A sandbox's identity: the workspace, the agent, and the conversation or
/// run it serves.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    /// `workspaces.id`.
    pub workspace_id: String,
    pub agent_id: String,
    /// The conversation id for chat turns, the run id otherwise.
    pub session_id: String,
}

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

impl SessionKey {
    pub fn new(
        workspace_id: impl Into<String>,
        agent_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            agent_id: agent_id.into(),
            session_id: session_id.into(),
        }
    }

    /// The pod's name: the same on every replica, so two replicas that start
    /// the same sandbox at once get one pod (the second create answers 409).
    pub fn pod_name(&self) -> String {
        format!("sbx-{}", self.session_label())
    }

    /// The pod's session label (a hash: label values can't hold every id).
    pub fn session_label(&self) -> String {
        digest(&[&self.workspace_id, &self.agent_id, &self.session_id])[..40].to_owned()
    }

    /// The pod's workspace label, to count a workspace's sandboxes.
    pub fn workspace_label(&self) -> String {
        digest(&[&self.workspace_id])[..40].to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_stable_and_separate() {
        let a = SessionKey::new("ws_1", "agt_1", "conv_1");
        assert_eq!(
            a.pod_name(),
            SessionKey::new("ws_1", "agt_1", "conv_1").pod_name()
        );
        assert_ne!(
            a.pod_name(),
            SessionKey::new("ws_2", "agt_1", "conv_1").pod_name()
        );
        assert_ne!(
            a.pod_name(),
            SessionKey::new("ws_1", "agt_2", "conv_1").pod_name()
        );
        // No splicing two ids into one.
        assert_ne!(
            SessionKey::new("ws_1", "ab", "c").pod_name(),
            SessionKey::new("ws_1", "a", "bc").pod_name()
        );
        assert_eq!(
            a.workspace_label(),
            SessionKey::new("ws_1", "x", "y").workspace_label()
        );
        // A DNS label: 63 characters at most.
        assert!(a.pod_name().len() <= 63);
        assert!(
            a.pod_name()
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        );
    }
}
