//! What the collector publishes instead of calling the `PanelProject`
//! object: one message per call on `panel.ops.v1.<workspace>` (the
//! `PANEL_STATE` stream), which `weldsuite consume`'s `panel-state` applies
//! to the workspace's tenant tables in stream order.

use serde::{Deserialize, Serialize};
use weldsuite_panel::project_state::{GroupOp, PeopleOp};

/// The operations' subject prefix; the workspace id is the last token.
pub(crate) const OPS_SUBJECT: &str = "panel.ops.v1";

/// One collector call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpMessage {
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    pub(crate) project_id: String,
    /// When the collector took the call (ISO 8601): the object's `now` for
    /// it (first and last seen).
    pub(crate) at: String,
    #[serde(flatten)]
    pub(crate) op: ProjectOp,
}

/// The object method a message stands for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ProjectOp {
    /// `identify({ anonId, userId, ts })`.
    Identify {
        anon_id: String,
        user_id: String,
        ts: String,
    },
    /// `applyPeopleOps({ ops })`.
    PeopleOps { ops: Vec<PeopleOp> },
    /// `applyGroupOps({ ops })`.
    GroupOps { ops: Vec<GroupOp> },
    /// `ensureGroupTypes(types)`.
    EnsureGroupTypes { types: Vec<String> },
    /// Nothing to apply: the collector found the project's Valkey cache
    /// empty, so the applier fills it from the tenant tables.
    Warm,
}

impl OpMessage {
    /// The subject it goes on.
    pub(crate) fn subject(&self) -> String {
        format!("{OPS_SUBJECT}.{}", self.workspace_id)
    }

    /// What the applier refuses outright (a dead letter, not a retry): ids
    /// Postgres can't store, a time that isn't one, or a subject naming
    /// another workspace.
    pub(crate) fn problem(&self, subject: &str) -> Option<String> {
        if subject.rsplit('.').next() != Some(self.workspace_id.as_str()) {
            return Some(format!(
                "the message is for workspace {} but came on {subject}",
                self.workspace_id
            ));
        }
        if self.workspace_id.is_empty() || self.project_id.is_empty() {
            return Some("the message names no workspace or project".to_owned());
        }
        if super::rules::iso_millis(&self.at).is_none() {
            return Some(format!("the message time {:?} is not ISO 8601", self.at));
        }
        let text = serde_json::to_string(self).unwrap_or_default();
        // `\u0000` in the JSON: a NUL, which Postgres text can't hold.
        text.contains("\\u0000")
            .then(|| "the message holds a NUL character".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};

    use super::*;

    #[test]
    fn messages_carry_the_project_the_time_and_the_call() {
        let message = OpMessage {
            workspace_id: "ws_1".into(),
            project_id: "pnp_1".into(),
            at: "2026-11-18T10:00:00.000Z".into(),
            op: ProjectOp::PeopleOps {
                ops: vec![PeopleOp::Set {
                    user_id: "u_1".into(),
                    ts: "2026-11-18T09:59:59.000Z".into(),
                    props: Map::from_iter([("plan".to_owned(), json!("pro"))]),
                }],
            },
        };
        let value = serde_json::to_value(&message).expect("json");
        assert_eq!(
            value,
            json!({
                "workspaceId": "ws_1", "projectId": "pnp_1", "at": "2026-11-18T10:00:00.000Z",
                "op": "peopleOps",
                "ops": [{ "op": "set", "userId": "u_1", "ts": "2026-11-18T09:59:59.000Z", "props": { "plan": "pro" } }]
            })
        );
        let back: OpMessage = serde_json::from_value(value).expect("back");
        assert_eq!(back, message);
        assert_eq!(message.subject(), "panel.ops.v1.ws_1");
        assert_eq!(message.problem("panel.ops.v1.ws_1"), None);
        assert!(message.problem("panel.ops.v1.ws_2").is_some());

        let warm: OpMessage = serde_json::from_value(json!({
            "workspaceId": "ws_1", "projectId": "pnp_1", "at": "2026-11-18T10:00:00.000Z", "op": "warm"
        }))
        .expect("a warm-up");
        assert_eq!(warm.op, ProjectOp::Warm);
        let nul = OpMessage {
            op: ProjectOp::Identify {
                anon_id: "a\u{0}".into(),
                user_id: "u".into(),
                ts: "t".into(),
            },
            ..warm
        };
        assert!(nul.problem("panel.ops.v1.ws_1").is_some());
    }
}
