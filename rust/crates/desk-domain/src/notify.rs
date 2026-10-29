//! WeldDesk's notification helpers (`@weldsuite/notifications`,
//! `helpers/helpdesk.ts`): a conversation or ticket was assigned to a
//! teammate, and a customer replied on one a teammate owns.
//!
//! Both honour the workspace's helpdesk notification settings
//! (`helpdesk_settings.notifications.notifyOnAssignment` /
//! `notifyOnCustomerReply`); a missing row or key counts as on. This module
//! decides whether to notify and builds the notification; delivering it
//! (the `notifications` row, in-app, email, push) is
//! `createAndDeliverNotification`, the shared notifications crate.

use serde_json::{Value, json};
use weldsuite_db::PgPool;

/// What the notification points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityKind {
    Conversation,
    Ticket,
}

impl EntityKind {
    fn noun(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Ticket => "ticket",
        }
    }

    /// `actionUrlFor`.
    pub fn action_url(self, id: &str) -> String {
        match self {
            Self::Ticket => format!("/welddesk/tickets/{id}"),
            Self::Conversation => format!("/welddesk/inbox/{id}"),
        }
    }

    /// `entityTypeFor`.
    pub fn entity_type(self) -> &'static str {
        match self {
            Self::Ticket => "ticket",
            Self::Conversation => "desk_conversation",
        }
    }

    /// The push data (`{ ticketId }` / `{ conversationId }`).
    pub fn data(self, id: &str) -> Value {
        match self {
            Self::Ticket => json!({ "ticketId": id }),
            Self::Conversation => json!({ "conversationId": id }),
        }
    }
}

/// A helpdesk notification to deliver (`CreateNotificationParams`).
#[derive(Debug, Clone, PartialEq)]
pub struct HelpdeskNotification {
    pub user_id: String,
    pub title: String,
    pub body: String,
    /// Always `helpdesk`.
    pub category: &'static str,
    pub notification_type: &'static str,
    pub entity_type: &'static str,
    pub entity_id: String,
    pub action_url: String,
    pub severity: &'static str,
    pub actor_type: &'static str,
    pub actor_id: Option<String>,
    pub data: Value,
}

/// `helpdeskPreview(text, max)`: whitespace collapsed, cut to `max`
/// characters (UTF-16 units) with an ellipsis.
pub fn preview(text: Option<&str>, max: usize) -> String {
    let flat = text
        .unwrap_or_default()
        .split(|c: char| c.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units: Vec<u16> = flat.encode_utf16().collect();
    if units.len() <= max {
        return flat;
    }
    let cut = String::from_utf16_lossy(&units[..max - 1]);
    format!("{}…", cut.trim_end())
}

/// `loadHelpdeskNotificationSettings` + `isHelpdeskNotificationEnabled`:
/// on unless the stored settings say `false`.
async fn enabled(db: &PgPool, key: &str) -> Result<bool, sqlx::Error> {
    let row: Option<Option<Value>> = sqlx::query_scalar(
        "select notifications from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(row
        .flatten()
        .is_none_or(|settings| settings[key] != Value::Bool(false)))
}

/// `memberName(db, userId)`: the member's trimmed name, if any; a failed
/// lookup is no name.
async fn member_name(db: &PgPool, user_id: &str) -> Option<String> {
    let row: Result<Option<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await;
    match row {
        Ok(name) => name
            .flatten()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty()),
        Err(error) => {
            tracing::error!(%error, "[Notifications] Failed to resolve member name");
            None
        }
    }
}

/// `sendTicketAssignedNotification`, up to the delivery: the notification,
/// or `None` when nothing is sent (no assignee, a self-assignment, the
/// workspace turned `notifyOnAssignment` off).
#[allow(clippy::too_many_arguments)]
pub async fn ticket_assigned(
    db: &PgPool,
    assignee_id: &str,
    assigned_by: Option<&str>,
    kind: EntityKind,
    entity_id: &str,
    subject: Option<&str>,
    reference: Option<&str>,
) -> Result<Option<HelpdeskNotification>, sqlx::Error> {
    if assignee_id.is_empty() || Some(assignee_id) == assigned_by {
        return Ok(None);
    }
    if !enabled(db, "notifyOnAssignment").await? {
        return Ok(None);
    }
    let assigner = match assigned_by {
        Some(user) => member_name(db, user).await,
        None => None,
    };
    let noun = kind.noun();
    let label = Some(preview(subject, 120))
        .filter(|l| !l.is_empty())
        .or_else(|| {
            reference
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("a {noun}"));
    let body = match assigner {
        Some(name) => format!("{name} assigned \"{label}\" to you"),
        None => format!("\"{label}\" was assigned to you"),
    };
    Ok(Some(HelpdeskNotification {
        user_id: assignee_id.to_owned(),
        title: match kind {
            EntityKind::Ticket => "Ticket assigned to you".to_owned(),
            EntityKind::Conversation => "Conversation assigned to you".to_owned(),
        },
        body,
        category: "helpdesk",
        notification_type: "ticket_assigned",
        entity_type: kind.entity_type(),
        entity_id: entity_id.to_owned(),
        action_url: kind.action_url(entity_id),
        severity: "info",
        actor_type: if assigned_by.is_some() {
            "user"
        } else {
            "system"
        },
        actor_id: assigned_by.map(str::to_owned),
        data: kind.data(entity_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_collapse_and_cut() {
        assert_eq!(preview(Some("  a \n b  "), 180), "a b");
        assert_eq!(preview(None, 10), "");
        assert_eq!(preview(Some("abcdefghijkl"), 5), "abcd…");
        assert_eq!(preview(Some("abc defghijkl"), 5), "abc…");
    }
}
