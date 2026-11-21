//! The `identities_v1`, `people_v1` and `groups_v1` rows a change writes,
//! and where they go: `panel.{identities,people,groups}.v1.<workspace>` on
//! the `PANEL_STATE` stream, which `panel-writer` commits to the Iceberg
//! tables (the object's `PANEL_IDENTITIES`, `PANEL_PEOPLE` and
//! `PANEL_GROUPS_STREAM`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use weldsuite_panel::ProjectRef;
use weldsuite_ports::{BusMessage, DynEventBus, PortError};

/// The rows one change writes, in the order the object sends them.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Emitted {
    pub(crate) identities: Vec<Value>,
    pub(crate) people: Vec<Value>,
    pub(crate) groups: Vec<Value>,
}

impl Emitted {
    pub(crate) fn is_empty(&self) -> bool {
        self.identities.is_empty() && self.people.is_empty() && self.groups.is_empty()
    }

    /// Every row with its subject prefix, identities first.
    fn subjects(&self) -> impl Iterator<Item = (&'static str, &Value)> {
        self.identities
            .iter()
            .map(|row| ("panel.identities.v1", row))
            .chain(self.people.iter().map(|row| ("panel.people.v1", row)))
            .chain(self.groups.iter().map(|row| ("panel.groups.v1", row)))
    }
}

/// An `identities_v1` row.
pub(crate) fn identity_row(
    project: ProjectRef<'_>,
    anon_id: &str,
    user_id: &str,
    ts: &str,
) -> Value {
    json!({
        "workspace_id": project.workspace_id,
        "project_id": project.project_id,
        "anon_id": anon_id,
        "user_id": user_id,
        "ts": ts,
    })
}

/// A `people_v1` snapshot: the properties' JSON, `{}` when deleted.
pub(crate) fn person_row(
    project: ProjectRef<'_>,
    user_id: &str,
    version: i64,
    ts: &str,
    properties: &str,
    deleted: bool,
) -> Value {
    json!({
        "workspace_id": project.workspace_id,
        "project_id": project.project_id,
        "user_id": user_id,
        "version": version,
        "ts": ts,
        "properties": if deleted { "{}" } else { properties },
        "deleted": deleted,
    })
}

/// A `groups_v1` snapshot.
pub(crate) fn group_row(
    project: ProjectRef<'_>,
    group_type: &str,
    group_key: &str,
    version: i64,
    ts: &str,
    properties: &str,
    deleted: bool,
) -> Value {
    json!({
        "workspace_id": project.workspace_id,
        "project_id": project.project_id,
        "group_type": group_type,
        "group_key": group_key,
        "version": version,
        "ts": ts,
        "properties": if deleted { "{}" } else { properties },
        "deleted": deleted,
    })
}

/// The event bus the rows go to; without one they are not written (one
/// warning), as the object without its streams.
#[derive(Clone)]
pub(crate) struct RowSink {
    bus: Option<Arc<dyn DynEventBus>>,
    warned: Arc<AtomicBool>,
}

impl RowSink {
    pub(crate) fn new(bus: Option<Arc<dyn DynEventBus>>) -> Self {
        Self {
            bus,
            warned: Arc::default(),
        }
    }

    /// Publishes the rows one after the other, the `n`th with the message id
    /// `id(n)`, and returns when the stream stored them all.
    pub(crate) async fn publish(
        &self,
        workspace_id: &str,
        rows: &Emitted,
        id: impl Fn(usize) -> String,
    ) -> Result<(), PortError> {
        if rows.is_empty() {
            return Ok(());
        }
        let Some(bus) = &self.bus else {
            if !self.warned.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    "panel: NATS is not configured: identities_v1, people_v1 and groups_v1 rows are not written"
                );
            }
            return Ok(());
        };
        for (n, (prefix, row)) in rows.subjects().enumerate() {
            let message = BusMessage::json(format!("{prefix}.{workspace_id}"), id(n), row)?;
            bus.publish_boxed(message).await?;
        }
        Ok(())
    }

    /// After a change is saved: a failure is logged and never undoes it (the
    /// object's `emit`).
    pub(crate) async fn emit(&self, workspace_id: &str, rows: &Emitted) {
        if let Err(error) = self
            .publish(workspace_id, rows, |_| weldsuite_kit::generate_id("pnrw"))
            .await
        {
            tracing::error!(workspace_id, %error, "panel: a project state row was not written");
        }
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::RecordingEventBus;

    use super::*;

    #[tokio::test]
    async fn rows_go_to_their_table_s_subject_in_order() {
        let bus = Arc::new(RecordingEventBus::default());
        let sink = RowSink::new(Some(Arc::clone(&bus) as Arc<dyn DynEventBus>));
        let project = ProjectRef {
            workspace_id: "ws_1",
            project_id: "pnp_1",
        };
        let rows = Emitted {
            identities: vec![identity_row(project, "a", "u", "2026-11-18T10:00:00.000Z")],
            people: vec![person_row(
                project,
                "u",
                3,
                "2026-11-18T10:00:00.000Z",
                r#"{"a":1}"#,
                true,
            )],
            groups: vec![group_row(
                project,
                "company",
                "acme",
                4,
                "2026-11-18T10:00:00.000Z",
                r#"{"a":1}"#,
                false,
            )],
        };
        sink.publish("ws_1", &rows, |n| format!("id-{n}"))
            .await
            .expect("published");
        let sent: Vec<(String, String)> = bus
            .messages()
            .into_iter()
            .map(|message| (message.subject, message.id))
            .collect();
        assert_eq!(
            sent,
            [
                ("panel.identities.v1.ws_1", "id-0"),
                ("panel.people.v1.ws_1", "id-1"),
                ("panel.groups.v1.ws_1", "id-2"),
            ]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
        );
        let person = bus.messages()[1].payload_json().expect("json");
        assert_eq!(person["properties"], "{}");
        assert_eq!(person["deleted"], true);
        let group = bus.messages()[2].payload_json().expect("json");
        assert_eq!(group["properties"], r#"{"a":1}"#);
        // Without a bus nothing is sent and nothing fails.
        RowSink::new(None)
            .publish("ws_1", &rows, |n| n.to_string())
            .await
            .expect("no bus");
    }
}
