//! Linked tickets (`@weldsuite/db/lib/desk-links` and `desk-merge-target`,
//! `packages/core/db/src/lib/desk-links.ts`): parent/child links, major
//! incidents and merging duplicates. The only writer of
//! `desk_conversations.parent_conversation_id`, `is_major_incident` and
//! `merged_into_id`; every change also lands on the timeline as an internal
//! event (`linked`, `unlinked`, `merged_into`, `merged_from`,
//! `incident_marked`, `incident_unmarked`) through [`webchat::append`].
//!
//! The rules: one level (a child can't have children, a parent can't have a
//! parent, no self-links; a major incident can't be a child and a child
//! can't be one); unmarking an incident unlinks its children; a duplicate
//! merges into a kept conversation of the same customer, is closed, and a
//! later customer message on it lands on the kept one when that customer can
//! see it ([`merge_follow_up_target`], which [`webchat::append`] follows).
//! Callers publish each change, in order.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::table::WriteError;
use crate::webchat::{self, Append, AppendError, Appended, DESK_CONVERSATIONS};

/// A merge chain longer than this is a data error; the last one reached is used.
const MAX_MERGE_HOPS: usize = 10;

/// `MAX_DESK_CHILDREN`: most tickets one parent (a major incident) links, so
/// an incident update or close stays within what one request can do.
pub const MAX_CHILDREN: i64 = 200;

/// Why a link change stopped.
#[derive(Debug)]
pub enum LinkError {
    /// `DeskConversationNotFoundError` for this id.
    NotFound(String),
    /// `DeskLinkRejectedError`: a 409 with `{ reason }`.
    Rejected {
        reason: &'static str,
        message: String,
    },
    Write(WriteError),
}

impl From<sqlx::Error> for LinkError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "conversation {id} not found"),
            Self::Rejected { message, .. } => f.write_str(message),
            Self::Write(error) => error.fmt(f),
        }
    }
}

fn rejected(reason: &'static str, message: impl Into<String>) -> LinkError {
    LinkError::Rejected {
        reason,
        message: message.into(),
    }
}

/// `DeskLinkResult`: the conversation the request was about as it stands
/// now, and every timeline entry written, in order.
#[derive(Debug)]
pub struct LinkResult {
    pub conversation: Value,
    pub changes: Vec<Appended>,
}

/// `MergeDeskConversationsResult`.
#[derive(Debug)]
pub struct MergeResult {
    pub conversation: Value,
    pub target: Value,
    pub changes: Vec<Appended>,
}

// ── the merge target ──────────────────────────────────────────────────────────

/// `deskMergeFollowUpTarget(db, conversation)`: where a customer message
/// written on `conversation` lands. The conversation it was (finally) merged
/// into when the customer who writes on the duplicate can see that one (the
/// same visitor, or a verified email that matches, as `canAccessDeskConversation`
/// rules), else the duplicate itself.
pub async fn merge_follow_up_target(
    db: &PgPool,
    conversation: Value,
) -> Result<Value, sqlx::Error> {
    let target = merge_target(db, conversation.clone()).await?;
    if target["id"] == conversation["id"] {
        return Ok(conversation);
    }
    let visitor = conversation["visitor_id"]
        .as_str()
        .filter(|v| !v.is_empty());
    if visitor.is_some() && target["visitor_id"].as_str() == visitor {
        return Ok(target);
    }
    let writer = verified_emails(db, &conversation).await?;
    if writer.is_empty() {
        return Ok(conversation);
    }
    let kept = verified_emails(db, &target).await?;
    if writer.iter().any(|email| kept.contains(email)) {
        Ok(target)
    } else {
        Ok(conversation)
    }
}

/// The verified addresses a conversation's customer writes from: the sender of
/// an email conversation, and its visitor's verified email.
async fn verified_emails(db: &PgPool, conversation: &Value) -> Result<Vec<String>, sqlx::Error> {
    let mut emails = Vec::new();
    if conversation["channel"].as_str() == Some("email")
        && let Some(email) = conversation["email"].as_str()
    {
        emails.push(email.trim().to_lowercase());
    }
    if let Some(visitor) = conversation["visitor_id"]
        .as_str()
        .filter(|v| !v.is_empty())
    {
        let verified: Option<Option<String>> =
            sqlx::query_scalar("select verified_email from desk_visitors where id = $1 limit 1")
                .bind(visitor)
                .fetch_optional(db)
                .await?;
        if let Some(Some(email)) = verified {
            emails.push(email.trim().to_lowercase());
        }
    }
    Ok(emails)
}

/// `deskMergeTarget(db, conversation)`, on a raw `to_jsonb` row as
/// [`webchat::append`] reads it: the conversation it was (finally) merged
/// into, or itself.
pub async fn merge_target(db: &PgPool, conversation: Value) -> Result<Value, sqlx::Error> {
    let mut current = conversation;
    let mut seen = vec![current["id"].as_str().unwrap_or_default().to_owned()];
    for _ in 0..MAX_MERGE_HOPS {
        let Some(next_id) = current["merged_into_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
        else {
            break;
        };
        if seen.contains(&next_id) {
            break;
        }
        let next: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from desk_conversations t where t.id = $1 limit 1",
        )
        .bind(&next_id)
        .fetch_optional(db)
        .await?;
        let Some(next) = next else { break };
        seen.push(next_id);
        current = next;
    }
    Ok(current)
}

// ── rows ──────────────────────────────────────────────────────────────────────

async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(webchat::get(db, id, false).await?.map(|(row, _)| row))
}

async fn load(db: &PgPool, id: &str) -> Result<Value, LinkError> {
    find(db, id)
        .await?
        .ok_or_else(|| LinkError::NotFound(id.to_owned()))
}

/// A conversation's children by number; `open_only` leaves out closed and
/// merged ones.
async fn children_of(db: &PgPool, id: &str, open_only: bool) -> Result<Vec<Value>, sqlx::Error> {
    let sql = if open_only {
        "select to_jsonb(t) from desk_conversations t
          where t.parent_conversation_id = $1 and t.state = 'open' and t.merged_into_id is null
          order by t.conversation_number asc, t.id asc"
    } else {
        "select to_jsonb(t) from desk_conversations t
          where t.parent_conversation_id = $1
          order by t.conversation_number asc, t.id asc"
    };
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(id).fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(|row| DESK_CONVERSATIONS.js(row))
        .collect())
}

async fn has_children(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(select 1 from desk_conversations where parent_conversation_id = $1)",
    )
    .bind(id)
    .fetch_one(db)
    .await
}

/// One link column, with `updatedAt`.
enum Column {
    Parent(Option<String>),
    Incident(bool),
    MergedInto(String),
}

async fn write_column(db: &PgPool, id: &str, column: Column) -> Result<(), sqlx::Error> {
    let now = webchat::now();
    let query = match column {
        Column::Parent(parent) => sqlx::query(
            "update desk_conversations set parent_conversation_id = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(id)
        .bind(parent),
        Column::Incident(flag) => sqlx::query(
            "update desk_conversations set is_major_incident = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(id)
        .bind(flag),
        Column::MergedInto(target) => sqlx::query(
            "update desk_conversations set merged_into_id = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(id)
        .bind(target),
    };
    query.bind(now).execute(db).await?;
    Ok(())
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str().filter(|value| !value.is_empty())
}

/// `otherOf(other, linkRole)`: the other conversation on an event.
fn other_of(other: &Value, role: Option<&str>) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("linkedConversationId".to_owned(), other["id"].clone());
    extra.insert(
        "linkedConversationNumber".to_owned(),
        other["conversationNumber"].clone(),
    );
    if let Some(role) = role {
        extra.insert("linkRole".to_owned(), json!(role));
    }
    extra
}

/// `linkEvent(...)`: an internal event on `conversation_id` by the agent.
async fn event(
    db: &PgPool,
    author_id: Option<&str>,
    conversation_id: &str,
    event_type: &str,
    extra: Map<String, Value>,
) -> Result<Appended, LinkError> {
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    metadata.extend(extra);
    webchat::append(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type: "agent",
            author_id,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|error| match error {
        AppendError::NotFound => LinkError::NotFound(conversation_id.to_owned()),
        AppendError::Write(error) => LinkError::Write(error),
    })
}

/// `lastFor(id, changes, fallback)`.
fn last_for(id: &str, changes: &[Appended], fallback: &Value) -> Value {
    changes
        .iter()
        .rev()
        .find(|change| change.conversation["id"] == id)
        .map_or_else(|| fallback.clone(), |change| change.conversation.clone())
}

fn summary(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "conversationNumber": row["conversationNumber"],
        "title": row["title"],
        "state": row["state"],
        "channel": row["channel"],
        "name": row["name"],
        "email": row["email"],
        "assigneeId": row["assigneeId"],
        "isMajorIncident": row["isMajorIncident"],
    })
}

// ── reading ───────────────────────────────────────────────────────────────────

/// `getDeskConversationLinks(db, id)`: the parent, children and merges;
/// `None` when the conversation doesn't exist.
pub async fn links(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(conversation) = find(db, id).await? else {
        return Ok(None);
    };
    let parent = match text(&conversation, "parentConversationId") {
        Some(parent) => find(db, parent).await?,
        None => None,
    };
    let merged_into = match text(&conversation, "mergedIntoId") {
        Some(target) => find(db, target).await?,
        None => None,
    };
    let children = children_of(db, id, false).await?;
    let merged_from: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t where t.merged_into_id = $1
          order by t.conversation_number asc, t.id asc",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(Some(json!({
        "parent": parent.as_ref().map_or(Value::Null, summary),
        "children": children.iter().map(summary).collect::<Vec<_>>(),
        "mergedInto": merged_into.as_ref().map_or(Value::Null, summary),
        "mergedFrom": merged_from
            .into_iter()
            .map(|row| summary(&DESK_CONVERSATIONS.js(row)))
            .collect::<Vec<_>>(),
    })))
}

// ── parent / child ────────────────────────────────────────────────────────────

/// `unlinkFromParent(...)`: an `unlinked` event on the child, and on the
/// parent when it still exists.
async fn unlink_from_parent(
    db: &PgPool,
    author_id: Option<&str>,
    child: &Value,
    previous_id: &str,
) -> Result<Vec<Appended>, LinkError> {
    let previous = find(db, previous_id).await?;
    let mut extra = Map::new();
    extra.insert("linkedConversationId".to_owned(), json!(previous_id));
    extra.insert(
        "linkedConversationNumber".to_owned(),
        previous
            .as_ref()
            .map_or(Value::Null, |p| p["conversationNumber"].clone()),
    );
    extra.insert("linkRole".to_owned(), json!("parent"));
    let child_id = child["id"].as_str().unwrap_or_default();
    let mut changes = vec![event(db, author_id, child_id, "unlinked", extra).await?];
    if let Some(previous) = previous {
        let id = previous["id"].as_str().unwrap_or_default();
        changes.push(
            event(
                db,
                author_id,
                id,
                "unlinked",
                other_of(child, Some("child")),
            )
            .await?,
        );
    }
    Ok(changes)
}

/// `assertLinkable(db, child, parent)`.
async fn assert_linkable(db: &PgPool, child: &Value, parent: &Value) -> Result<(), LinkError> {
    if text(child, "mergedIntoId").is_some() {
        return Err(rejected(
            "merged",
            "This ticket was merged into another one",
        ));
    }
    let number = &parent["conversationNumber"];
    if text(parent, "mergedIntoId").is_some() {
        return Err(rejected(
            "target_merged",
            format!("Ticket #{number} was merged into another ticket"),
        ));
    }
    if text(parent, "parentConversationId").is_some() {
        return Err(rejected(
            "parent_is_child",
            format!("Ticket #{number} is a child ticket itself, so it can't have child tickets"),
        ));
    }
    if child["isMajorIncident"] == Value::Bool(true) {
        return Err(rejected(
            "is_incident",
            "A major incident can't be a child ticket",
        ));
    }
    if has_children(db, child["id"].as_str().unwrap_or_default()).await? {
        return Err(rejected(
            "has_children",
            "This ticket has child tickets, so it can't become a child ticket",
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "select count(*) from desk_conversations where parent_conversation_id = $1",
    )
    .bind(parent["id"].as_str().unwrap_or_default())
    .fetch_one(db)
    .await?;
    if count >= MAX_CHILDREN {
        return Err(rejected(
            "too_many_children",
            format!("Ticket #{number} already has {MAX_CHILDREN} linked tickets"),
        ));
    }
    Ok(())
}

/// `setDeskConversationParent(db, input)`: set or clear the parent; linking
/// to another parent first unlinks the current one.
pub async fn set_parent(
    db: &PgPool,
    author_id: Option<&str>,
    conversation_id: &str,
    parent_id: Option<&str>,
) -> Result<LinkResult, LinkError> {
    let child = load(db, conversation_id).await?;
    let id = child["id"].as_str().unwrap_or_default().to_owned();
    let previous_id = text(&child, "parentConversationId").map(str::to_owned);

    let Some(parent_id) = parent_id else {
        let Some(previous_id) = previous_id else {
            return Ok(LinkResult {
                conversation: child,
                changes: Vec::new(),
            });
        };
        write_column(db, &id, Column::Parent(None)).await?;
        let changes = unlink_from_parent(db, author_id, &child, &previous_id).await?;
        return Ok(LinkResult {
            conversation: last_for(&id, &changes, &child),
            changes,
        });
    };

    if parent_id == id {
        return Err(rejected("self", "A ticket can't be linked to itself"));
    }
    if previous_id.as_deref() == Some(parent_id) {
        return Ok(LinkResult {
            conversation: child,
            changes: Vec::new(),
        });
    }
    let parent = load(db, parent_id).await?;
    assert_linkable(db, &child, &parent).await?;

    let parent_row_id = parent["id"].as_str().unwrap_or_default().to_owned();
    write_column(db, &id, Column::Parent(Some(parent_row_id.clone()))).await?;
    let mut changes = Vec::new();
    if let Some(previous_id) = previous_id {
        changes.extend(unlink_from_parent(db, author_id, &child, &previous_id).await?);
    }
    changes.push(
        event(
            db,
            author_id,
            &id,
            "linked",
            other_of(&parent, Some("parent")),
        )
        .await?,
    );
    changes.push(
        event(
            db,
            author_id,
            &parent_row_id,
            "linked",
            other_of(&child, Some("child")),
        )
        .await?,
    );
    Ok(LinkResult {
        conversation: last_for(&id, &changes, &child),
        changes,
    })
}

// ── major incidents ───────────────────────────────────────────────────────────

/// `setDeskMajorIncident(db, input)`: mark or unmark; unmarking unlinks the
/// children (an `unlinked` event each, then `incident_unmarked` with
/// `unlinkedCount`).
pub async fn set_major_incident(
    db: &PgPool,
    author_id: Option<&str>,
    conversation_id: &str,
    flag: bool,
) -> Result<LinkResult, LinkError> {
    let conversation = load(db, conversation_id).await?;
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    if conversation["isMajorIncident"] == Value::Bool(flag) {
        return Ok(LinkResult {
            conversation,
            changes: Vec::new(),
        });
    }
    if flag {
        if text(&conversation, "parentConversationId").is_some() {
            return Err(rejected(
                "incident_child",
                "A child ticket can't be a major incident",
            ));
        }
        if text(&conversation, "mergedIntoId").is_some() {
            return Err(rejected(
                "merged",
                "This ticket was merged into another one",
            ));
        }
        write_column(db, &id, Column::Incident(true)).await?;
        let change = event(db, author_id, &id, "incident_marked", Map::new()).await?;
        return Ok(LinkResult {
            conversation: change.conversation.clone(),
            changes: vec![change],
        });
    }

    let children = children_of(db, &id, false).await?;
    write_column(db, &id, Column::Incident(false)).await?;
    let mut changes = Vec::new();
    for child in &children {
        let child_id = child["id"].as_str().unwrap_or_default();
        write_column(db, child_id, Column::Parent(None)).await?;
        changes.push(
            event(
                db,
                author_id,
                child_id,
                "unlinked",
                other_of(&conversation, Some("parent")),
            )
            .await?,
        );
    }
    let mut extra = Map::new();
    extra.insert("unlinkedCount".to_owned(), json!(children.len()));
    changes.push(event(db, author_id, &id, "incident_unmarked", extra).await?);
    Ok(LinkResult {
        conversation: last_for(&id, &changes, &conversation),
        changes,
    })
}

/// `postDeskIncidentUpdate(db, input)`: one agent reply on the incident and
/// on each of its open children, with `metadata.incidentId`.
pub async fn post_incident_update(
    db: &PgPool,
    author_id: Option<&str>,
    incident_id: &str,
    body: &str,
) -> Result<LinkResult, LinkError> {
    let incident = load(db, incident_id).await?;
    if incident["isMajorIncident"] != Value::Bool(true) {
        return Err(rejected(
            "not_incident",
            "This ticket is not a major incident",
        ));
    }
    let id = incident["id"].as_str().unwrap_or_default().to_owned();
    let mut targets = vec![id.clone()];
    for child in children_of(db, &id, true).await? {
        targets.push(child["id"].as_str().unwrap_or_default().to_owned());
    }
    let mut changes = Vec::new();
    for target in &targets {
        let mut metadata = Map::new();
        metadata.insert("incidentId".to_owned(), json!(id));
        let appended = webchat::append(
            db,
            Append {
                conversation_id: target,
                kind: "message",
                author_type: "agent",
                author_id,
                body: Some(body.to_owned()),
                attachments: None,
                metadata: Some(metadata),
                assignee_id: None,
            },
        )
        .await
        .map_err(|error| match error {
            AppendError::NotFound => LinkError::NotFound(target.clone()),
            AppendError::Write(error) => LinkError::Write(error),
        })?;
        changes.push(appended);
    }
    Ok(LinkResult {
        conversation: last_for(&id, &changes, &incident),
        changes,
    })
}

/// `closeDeskIncidentChildren(db, input)`: close a major incident's open
/// children, each with its normal `closed` event; nothing for a
/// conversation that isn't an incident.
pub async fn close_incident_children(
    db: &PgPool,
    author_id: Option<&str>,
    incident_id: &str,
) -> Result<Vec<Appended>, LinkError> {
    let Some(incident) = find(db, incident_id).await? else {
        return Ok(Vec::new());
    };
    if incident["isMajorIncident"] != Value::Bool(true) {
        return Ok(Vec::new());
    }
    let id = incident["id"].as_str().unwrap_or_default().to_owned();
    let mut changes = Vec::new();
    for child in children_of(db, &id, true).await? {
        let mut extra = Map::new();
        extra.insert("assigneeId".to_owned(), Value::Null);
        extra.insert("incidentId".to_owned(), json!(id));
        let child_id = child["id"].as_str().unwrap_or_default();
        changes.push(event(db, author_id, child_id, "closed", extra).await?);
    }
    Ok(changes)
}

// ── merging duplicates ────────────────────────────────────────────────────────

/// `emailOf(value)`: trimmed and lower-cased, `None` when empty.
fn email_of(value: Option<&str>) -> Option<String> {
    value
        .map(|email| weldsuite_kit::validation::js_trim(email).to_lowercase())
        .filter(|email| !email.is_empty())
}

/// The emails a conversation's customer is known by: its own and its
/// visitor's verified one.
async fn customer_emails(db: &PgPool, row: &Value) -> Result<Vec<String>, sqlx::Error> {
    let mut emails = Vec::new();
    if let Some(own) = email_of(row["email"].as_str()) {
        emails.push(own);
    }
    if let Some(visitor) = text(row, "visitorId") {
        let verified: Option<Option<String>> =
            sqlx::query_scalar("select verified_email from desk_visitors where id = $1 limit 1")
                .bind(visitor)
                .fetch_optional(db)
                .await?;
        if let Some(email) = email_of(verified.flatten().as_deref()) {
            emails.push(email);
        }
    }
    Ok(emails)
}

/// `isSameDeskCustomer(db, a, b)`: the same visitor, the same CRM person, or
/// an email in common (own or verified).
pub async fn same_customer(db: &PgPool, a: &Value, b: &Value) -> Result<bool, sqlx::Error> {
    if text(a, "visitorId").is_some() && a["visitorId"] == b["visitorId"] {
        return Ok(true);
    }
    if text(a, "contactId").is_some() && a["contactId"] == b["contactId"] {
        return Ok(true);
    }
    let of_a = customer_emails(db, a).await?;
    let of_b = customer_emails(db, b).await?;
    Ok(of_a.iter().any(|email| of_b.contains(email)))
}

/// `mergeDeskConversations(db, input)`: the duplicate gets `merged_into_id`
/// and a `merged_into` event, is closed when open, and the kept one gets a
/// `merged_from` event.
pub async fn merge(
    db: &PgPool,
    author_id: Option<&str>,
    source_id: &str,
    target_id: &str,
) -> Result<MergeResult, LinkError> {
    let source = load(db, source_id).await?;
    let id = source["id"].as_str().unwrap_or_default().to_owned();
    if target_id == id {
        return Err(rejected("self", "A ticket can't be merged into itself"));
    }
    let target = load(db, target_id).await?;
    let kept = target["id"].as_str().unwrap_or_default().to_owned();
    if text(&source, "mergedIntoId").is_some() {
        return Err(rejected(
            "merged",
            "This ticket was already merged into another one",
        ));
    }
    if text(&target, "mergedIntoId").is_some() {
        return Err(rejected(
            "target_merged",
            format!(
                "Ticket #{} was merged into another ticket",
                target["conversationNumber"]
            ),
        ));
    }
    if source["isMajorIncident"] == Value::Bool(true) {
        return Err(rejected("is_incident", "A major incident can't be merged"));
    }
    if has_children(db, &id).await? {
        return Err(rejected(
            "has_children",
            "A ticket with child tickets can't be merged; unlink them first",
        ));
    }
    if !same_customer(db, &source, &target).await? {
        return Err(rejected(
            "different_customer",
            "Only tickets of the same customer can be merged; link them to a major incident instead",
        ));
    }

    write_column(db, &id, Column::MergedInto(kept.clone())).await?;
    let mut changes =
        vec![event(db, author_id, &id, "merged_into", other_of(&target, None)).await?];
    if source["state"] == "open" {
        let mut extra = Map::new();
        extra.insert("assigneeId".to_owned(), Value::Null);
        changes.push(event(db, author_id, &id, "closed", extra).await?);
    }
    changes.push(event(db, author_id, &kept, "merged_from", other_of(&source, None)).await?);
    Ok(MergeResult {
        conversation: last_for(&id, &changes, &source),
        target: last_for(&kept, &changes, &target),
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_and_lower_cased() {
        assert_eq!(
            email_of(Some("  Mo@Example.TEST ")).as_deref(),
            Some("mo@example.test")
        );
        assert_eq!(email_of(Some("   ")), None);
        assert_eq!(email_of(None), None);
    }

    #[test]
    fn the_last_change_of_a_conversation_wins() {
        let change = |id: &str, n: i64| Appended {
            conversation: json!({ "id": id, "n": n }),
            message: Value::Null,
            sla_check_at: None,
        };
        let changes = vec![change("a", 1), change("b", 2), change("a", 3)];
        assert_eq!(last_for("a", &changes, &Value::Null)["n"], json!(3));
        assert_eq!(
            last_for("c", &changes, &json!({ "id": "c" }))["id"],
            json!("c")
        );
    }

    #[test]
    fn an_event_names_the_other_conversation() {
        let other = json!({ "id": "dconv_1", "conversationNumber": 7 });
        let extra = other_of(&other, Some("parent"));
        assert_eq!(extra["linkedConversationId"], json!("dconv_1"));
        assert_eq!(extra["linkedConversationNumber"], json!(7));
        assert_eq!(extra["linkRole"], json!("parent"));
        assert!(!other_of(&other, None).contains_key("linkRole"));
    }

    #[test]
    fn link_events_stay_with_the_team() {
        for event in [
            "linked",
            "unlinked",
            "merged_into",
            "merged_from",
            "incident_marked",
            "incident_unmarked",
        ] {
            let message = json!({ "kind": "event", "metadata": { "eventType": event } });
            assert!(!webchat::is_public(&message), "{event}");
        }
        let closed = json!({ "kind": "event", "metadata": { "eventType": "closed" } });
        assert!(webchat::is_public(&closed));
    }
}
