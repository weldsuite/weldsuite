//! Problem management (`@weldsuite/db/lib/desk-problems`,
//! `packages/core/db/src/lib/desk-problems.ts`): a problem is the cause
//! behind one or more incidents (inbox conversations). The only writer of
//! `desk_problems` and of `desk_conversations.problem_id`; linking an
//! incident also lands on its timeline as an internal event
//! (`problem_linked`, `problem_unlinked`) through [`webchat::append`].
//!
//! The rules: a conversation belongs to at most one problem (replacing it
//! appends `problem_unlinked` then `problem_linked`, linking what is already
//! linked changes nothing); a merged duplicate can't be linked and a closed
//! problem takes no new incidents; the status moves the timestamps
//! ([`status_patch`]) and a known error needs a workaround or a root cause;
//! deleting a problem unlinks its incidents without timeline events.
//! Callers publish each change, in order.

#[rustfmt::skip]
#[path = "problems_tables.rs"]
mod tables;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, js_trim};

use crate::links::{self, MAX_CHILDREN};
use crate::list::{conversation_number, js_parse_int, like_pattern};
use crate::table::WriteError;
use crate::webchat::{self, Append, AppendError, Appended, DESK_CONVERSATIONS};
pub use tables::DESK_PROBLEMS;

/// `DESK_PROBLEM_STATUSES`.
pub const STATUSES: &[&str] = &["open", "investigating", "known_error", "resolved", "closed"];

/// Why a problem change stopped.
#[derive(Debug)]
pub enum ProblemError {
    /// `DeskProblemNotFoundError` for this id.
    NotFound(String),
    /// `DeskConversationNotFoundError` for this id.
    ConversationNotFound(String),
    /// `DeskProblemRejectedError`: a 409 with `{ reason }`.
    Rejected {
        reason: &'static str,
        message: String,
    },
    /// `DeskProblemFieldError`: a team or an owner that doesn't exist or is
    /// inactive, a 400 with `{ field }`.
    Field {
        field: &'static str,
        message: String,
    },
    Write(WriteError),
}

impl From<sqlx::Error> for ProblemError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

impl From<WriteError> for ProblemError {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl std::fmt::Display for ProblemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "Problem '{id}' not found"),
            Self::ConversationNotFound(id) => write!(f, "conversation {id} not found"),
            Self::Rejected { message, .. } | Self::Field { message, .. } => f.write_str(message),
            Self::Write(error) => error.fmt(f),
        }
    }
}

fn rejected(reason: &'static str, message: impl Into<String>) -> ProblemError {
    ProblemError::Rejected {
        reason,
        message: message.into(),
    }
}

// ── status rules (pure) ───────────────────────────────────────────────────────

/// `deskProblemStatusPatch(current, next, now)`: the timestamps a move to
/// `next` writes, as `(property, value)` (only the keys that change).
/// Nothing for a move to the status the problem already has.
pub fn status_patch(current: &Value, next: &str, now: &str) -> Vec<(&'static str, Value)> {
    if current["status"] == next {
        return Vec::new();
    }
    // `current.x ?? now`.
    let kept = |prop: &str| {
        if current[prop].is_null() {
            json!(now)
        } else {
            current[prop].clone()
        }
    };
    match next {
        "known_error" => vec![
            ("knownErrorAt", kept("knownErrorAt")),
            ("resolvedAt", Value::Null),
            ("closedAt", Value::Null),
        ],
        "resolved" => vec![("resolvedAt", json!(now)), ("closedAt", Value::Null)],
        "closed" => vec![("closedAt", json!(now)), ("resolvedAt", kept("resolvedAt"))],
        _ => vec![
            ("knownErrorAt", Value::Null),
            ("resolvedAt", Value::Null),
            ("closedAt", Value::Null),
        ],
    }
}

/// `blank(value)`: nothing, or only whitespace.
fn blank(value: Option<&str>) -> bool {
    value.is_none_or(|text| js_trim(text).is_empty())
}

/// `textOrNull(value)`: trimmed, `None` when nothing is left.
fn text_or_null(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `assertKnownErrorBacked(status, workaround, rootCause)`.
fn assert_known_error_backed(
    status: &str,
    workaround: Option<&str>,
    root_cause: Option<&str>,
) -> Result<(), ProblemError> {
    if status == "known_error" && blank(workaround) && blank(root_cause) {
        return Err(rejected(
            "workaround_required",
            "A known error needs a workaround or a root cause",
        ));
    }
    Ok(())
}

/// `assertOpenForIncidents(status, incidents)`: a problem logged as closed
/// takes no incidents (the rule [`assert_linkable`] applies to an existing
/// one). Checked before the problem is written: the link would otherwise fail
/// after the insert and leave the problem behind.
fn assert_open_for_incidents(status: &str, incidents: usize) -> Result<(), ProblemError> {
    if status == "closed" && incidents > 0 {
        return Err(rejected(
            "problem_closed",
            "A closed problem takes no incidents; link the tickets before closing it",
        ));
    }
    Ok(())
}

// ── validation ────────────────────────────────────────────────────────────────

/// `assertTeam(db, departmentId)`: the team exists, is active and not deleted.
async fn assert_team(db: &PgPool, department_id: &str) -> Result<(), ProblemError> {
    let usable: Option<bool> = sqlx::query_scalar(
        "select (is_active is distinct from false) and deleted_at is null
           from helpdesk_departments where id = $1 limit 1",
    )
    .bind(department_id)
    .fetch_optional(db)
    .await?;
    if usable == Some(true) {
        return Ok(());
    }
    Err(ProblemError::Field {
        field: "departmentId",
        message: format!("Team '{department_id}' does not exist or is inactive"),
    })
}

/// `assertMember(db, userId)`: an active member of the workspace.
async fn assert_member(db: &PgPool, user_id: &str) -> Result<(), ProblemError> {
    let member: Option<String> = sqlx::query_scalar(
        "select id from workspace_members
          where user_id = $1 and deleted_at is null and upper(status) = 'ACTIVE' limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if member.is_some() {
        return Ok(());
    }
    Err(ProblemError::Field {
        field: "assigneeId",
        message: format!("Member '{user_id}' does not exist or is inactive"),
    })
}

/// `assertOwnerAndTeam(db, input)`: the team first, then the owner; an empty
/// or missing value is not checked.
async fn assert_owner_and_team(
    db: &PgPool,
    assignee_id: Option<&str>,
    department_id: Option<&str>,
) -> Result<(), ProblemError> {
    if let Some(department_id) = department_id.filter(|id| !id.is_empty()) {
        assert_team(db, department_id).await?;
    }
    if let Some(assignee_id) = assignee_id.filter(|id| !id.is_empty()) {
        assert_member(db, assignee_id).await?;
    }
    Ok(())
}

// ── reading ───────────────────────────────────────────────────────────────────

/// `incidentCount` and `openIncidentCount` of the problem `t`: every
/// conversation linked to it, and the ones that are open and not merged away.
macro_rules! counts {
    () => {
        "(SELECT count(*)::int FROM desk_conversations ic WHERE ic.problem_id = t.id), \
         (SELECT count(*)::int FROM desk_conversations ic WHERE ic.problem_id = t.id \
           AND ic.state = 'open' AND ic.merged_into_id IS NULL)"
    };
}

/// `problemFilters(query)`: `$1` the statuses, `$2` known errors only, `$3`
/// the owner, `$4` the team, `$5` the search pattern and `$6` the number it
/// may name.
macro_rules! filters {
    () => {
        "($1::text[] is null or t.status = any($1)) \
         and (not $2::boolean or t.known_error_at IS NOT NULL) \
         and ($3::text is null or t.assignee_id = $3) \
         and ($4::text is null or t.department_id = $4) \
         and ($5::text is null or (t.title ILIKE $5 or t.description ILIKE $5 \
              or t.root_cause ILIKE $5 or t.workaround ILIKE $5 \
              or ($6::integer is not null and t.problem_number = $6)))"
    };
}

/// A problem row with its counts, as `counted(row)` returns it.
fn counted((row, incidents, open): (Value, i32, i32)) -> Value {
    let mut problem = DESK_PROBLEMS.js(row);
    if let Some(fields) = problem.as_object_mut() {
        fields.insert("incidentCount".to_owned(), json!(incidents));
        fields.insert("openIncidentCount".to_owned(), json!(open));
    }
    problem
}

async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    DESK_PROBLEMS.find_live(db, id).await
}

async fn load(db: &PgPool, id: &str) -> Result<Value, ProblemError> {
    find(db, id)
        .await?
        .ok_or_else(|| ProblemError::NotFound(id.to_owned()))
}

async fn find_conversation(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(webchat::get(db, id, false).await?.map(|(row, _)| row))
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str().filter(|value| !value.is_empty())
}

/// `getDeskProblem(db, id)`: one problem with its incident counts; `None`
/// when it doesn't exist.
pub async fn get(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<(Value, i32, i32)> = sqlx::query_as(concat!(
        "select to_jsonb(t), ",
        counts!(),
        " from desk_problems t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(counted))
}

/// [`get`] of a problem that was just read or written.
async fn reload(db: &PgPool, id: &str) -> Result<Value, ProblemError> {
    get(db, id)
        .await?
        .ok_or_else(|| ProblemError::NotFound(id.to_owned()))
}

/// `ListDeskProblemsQuery`.
#[derive(Debug, Default)]
pub struct ListQuery {
    pub statuses: Vec<String>,
    /// The known-error database: every problem that was ever a known error,
    /// resolved ones included.
    pub known_errors: bool,
    pub assignee_id: Option<String>,
    pub department_id: Option<String>,
    /// Title, description, root cause, workaround, or `#number`.
    pub q: Option<String>,
    /// An offset, as the other desk lists use.
    pub cursor: Option<String>,
    pub limit: Option<f64>,
}

/// `listDeskProblems(db, query)`: problems that still need work first, then
/// the most recently touched. The page, the total, whether there is more
/// and the next cursor.
pub async fn list(
    db: &PgPool,
    query: &ListQuery,
) -> Result<(Vec<Value>, i64, bool, Option<String>), sqlx::Error> {
    let limit = query.limit.unwrap_or(30.0).min(100.0);
    #[allow(clippy::cast_possible_truncation)]
    let page = limit as i64;
    let statuses = (!query.statuses.is_empty()).then(|| query.statuses.clone());
    let truthy = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    let term = query.q.as_deref().map(js_trim).filter(|t| !t.is_empty());
    let pattern = term.map(like_pattern);
    let number = term
        .and_then(conversation_number)
        .map(|n| i32::try_from(n).unwrap_or(i32::MAX));
    let offset = query
        .cursor
        .as_deref()
        .filter(|c| !c.is_empty())
        .and_then(js_parse_int)
        .filter(|o| *o != 0.0)
        .unwrap_or(0.0);
    #[allow(clippy::cast_possible_truncation)]
    let offset = offset as i64;

    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from desk_problems t where ",
        filters!()
    ))
    .bind(statuses.clone())
    .bind(query.known_errors)
    .bind(truthy(&query.assignee_id))
    .bind(truthy(&query.department_id))
    .bind(pattern.clone())
    .bind(number)
    .fetch_one(db)
    .await?;
    let rows: Vec<(Value, i32, i32)> = sqlx::query_as(concat!(
        "select to_jsonb(t), ",
        counts!(),
        " from desk_problems t where ",
        filters!(),
        " order by CASE WHEN t.status IN ('open', 'investigating', 'known_error') THEN 0 ELSE 1 END, \
          t.updated_at DESC, t.id DESC limit $7 offset $8"
    ))
    .bind(statuses)
    .bind(query.known_errors)
    .bind(truthy(&query.assignee_id))
    .bind(truthy(&query.department_id))
    .bind(pattern)
    .bind(number)
    .bind(page + 1)
    .bind(offset)
    .fetch_all(db)
    .await?;

    let mut data: Vec<Value> = rows.into_iter().map(counted).collect();
    let has_more = i64::try_from(data.len()).unwrap_or(i64::MAX) > page;
    if has_more {
        data.truncate(usize::try_from(page).unwrap_or(0));
    }
    let cursor = has_more.then(|| (offset + page).to_string());
    Ok((data, total, has_more, cursor))
}

/// `listDeskProblemConversations(db, problemId, { limit })`: a problem's
/// incidents by number, as link summaries. `limit` defaults to 100 and is
/// at most 500.
pub async fn conversations(
    db: &PgPool,
    problem_id: &str,
    limit: Option<f64>,
) -> Result<Vec<Value>, sqlx::Error> {
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.unwrap_or(100.0).min(500.0) as i64;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t where t.problem_id = $1
          order by t.conversation_number asc, t.id asc limit $2",
    )
    .bind(problem_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| links::summary(&DESK_CONVERSATIONS.js(row)))
        .collect())
}

/// `deskProblemSummaryOf(row)`: a problem as an incident's details panel
/// shows it.
pub fn summary(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "problemNumber": row["problemNumber"],
        "title": row["title"],
        "status": row["status"],
        "workaround": row["workaround"],
        "rootCause": row["rootCause"],
    })
}

/// `getDeskConversationProblem(db, conversationId)`: the problem a
/// conversation is linked to; `None` when it has none.
pub async fn conversation_problem(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from desk_conversations c
          inner join desk_problems p on p.id = c.problem_id
          where c.id = $1 limit 1",
    )
    .bind(conversation_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| summary(&DESK_PROBLEMS.js(row))))
}

// ── linking incidents ─────────────────────────────────────────────────────────

/// `problemEvent(...)`: an internal event on `conversation_id` by the agent,
/// naming the problem (`number` and `title` are null for one that is gone).
async fn problem_event(
    db: &PgPool,
    author_id: Option<&str>,
    conversation_id: &str,
    event_type: &str,
    (id, number, title): (&str, &Value, &Value),
) -> Result<Appended, ProblemError> {
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    metadata.insert("problemId".to_owned(), json!(id));
    metadata.insert("problemNumber".to_owned(), number.clone());
    metadata.insert("problemTitle".to_owned(), title.clone());
    append(
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
}

/// [`webchat::append`], with its errors as this module's.
async fn append(db: &PgPool, input: Append<'_>) -> Result<Appended, ProblemError> {
    let conversation_id = input.conversation_id.to_owned();
    webchat::append(db, input)
        .await
        .map_err(|error| match error {
            AppendError::NotFound => ProblemError::ConversationNotFound(conversation_id),
            AppendError::Write(error) => ProblemError::Write(error),
        })
}

/// `DeskConversationProblemResult`: the conversation as it stands now, the
/// linked problem after the change (null when it has none) and every
/// timeline entry written, in order.
#[derive(Debug)]
pub struct ConversationProblem {
    pub conversation: Value,
    pub problem: Value,
    pub changes: Vec<Appended>,
}

/// `assertLinkable(conversation, problem)`.
fn assert_linkable(conversation: &Value, problem: &Value) -> Result<(), ProblemError> {
    if text(conversation, "mergedIntoId").is_some() {
        return Err(rejected(
            "merged",
            "This ticket was merged into another one; link the kept ticket",
        ));
    }
    if problem["status"] == "closed" {
        return Err(rejected(
            "problem_closed",
            format!(
                "Problem #{} is closed and takes no new incidents",
                problem["problemNumber"]
            ),
        ));
    }
    Ok(())
}

/// `setDeskConversationProblem(db, input)`: link a conversation to a
/// problem, replace its problem, or unlink it (`problem_id: None`). No
/// events when nothing changes.
pub async fn set_conversation_problem(
    db: &PgPool,
    author_id: Option<&str>,
    conversation_id: &str,
    problem_id: Option<&str>,
) -> Result<ConversationProblem, ProblemError> {
    let conversation = find_conversation(db, conversation_id)
        .await?
        .ok_or_else(|| ProblemError::ConversationNotFound(conversation_id.to_owned()))?;
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let previous_id = conversation["problemId"].as_str().map(str::to_owned);
    let previous = match previous_id.as_deref().filter(|id| !id.is_empty()) {
        Some(previous_id) => find(db, previous_id).await?,
        None => None,
    };

    if problem_id == previous_id.as_deref() {
        return Ok(ConversationProblem {
            conversation,
            problem: previous.as_ref().map_or(Value::Null, summary),
            changes: Vec::new(),
        });
    }

    let next = match problem_id.filter(|id| !id.is_empty()) {
        Some(problem_id) => Some(load(db, problem_id).await?),
        None => None,
    };
    if let Some(next) = &next {
        assert_linkable(&conversation, next)?;
    }

    sqlx::query(
        "update desk_conversations set problem_id = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&id)
    .bind(next.as_ref().and_then(|next| next["id"].as_str()))
    .bind(webchat::now())
    .execute(db)
    .await?;

    let mut changes = Vec::new();
    if let Some(previous_id) = previous_id.as_deref().filter(|id| !id.is_empty()) {
        let (number, title) = previous
            .as_ref()
            .map_or((&Value::Null, &Value::Null), |previous| {
                (&previous["problemNumber"], &previous["title"])
            });
        changes.push(
            problem_event(
                db,
                author_id,
                &id,
                "problem_unlinked",
                (previous_id, number, title),
            )
            .await?,
        );
    }
    if let Some(next) = &next {
        let next_id = next["id"].as_str().unwrap_or_default();
        changes.push(
            problem_event(
                db,
                author_id,
                &id,
                "problem_linked",
                (next_id, &next["problemNumber"], &next["title"]),
            )
            .await?,
        );
    }
    let conversation = changes
        .last()
        .map_or(conversation, |last| last.conversation.clone());
    Ok(ConversationProblem {
        conversation,
        problem: next.as_ref().map_or(Value::Null, summary),
        changes,
    })
}

// ── writing problems ──────────────────────────────────────────────────────────

/// `CreateDeskProblemInput`, as the route's schema reads it (`None` is left
/// out or null).
#[derive(Debug, Default)]
pub struct NewProblem {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub assignee_id: Option<String>,
    pub department_id: Option<String>,
    pub root_cause: Option<String>,
    pub workaround: Option<String>,
    pub status: Option<String>,
    /// Incidents to link at creation.
    pub conversation_ids: Vec<String>,
}

/// `CreateDeskProblemResult`: the problem with its counts, and one
/// `problem_linked` entry per conversation linked at creation.
#[derive(Debug)]
pub struct Created {
    pub problem: Value,
    pub changes: Vec<Appended>,
}

/// The timestamps the route writes itself.
const TRUSTED: [&str; 5] = [
    "createdAt",
    "updatedAt",
    "knownErrorAt",
    "resolvedAt",
    "closedAt",
];

/// `createDeskProblem(db, input)`. `problem_number` is `MAX + 1` under a
/// unique index, so a number two problems took at once is tried again, five
/// times at most.
pub async fn create(
    db: &PgPool,
    author_id: Option<&str>,
    input: &NewProblem,
) -> Result<Created, ProblemError> {
    let status = input.status.as_deref().unwrap_or("open");
    let workaround = text_or_null(input.workaround.as_deref());
    let root_cause = text_or_null(input.root_cause.as_deref());
    assert_known_error_backed(status, workaround.as_deref(), root_cause.as_deref())?;
    assert_owner_and_team(
        db,
        input.assignee_id.as_deref(),
        input.department_id.as_deref(),
    )
    .await?;

    // Check every incident before anything is written.
    let mut conversation_ids: Vec<&str> = Vec::new();
    for id in &input.conversation_ids {
        if !conversation_ids.contains(&id.as_str()) {
            conversation_ids.push(id);
        }
    }
    for id in &conversation_ids {
        let found = find_conversation(db, id)
            .await?
            .ok_or_else(|| ProblemError::ConversationNotFound((*id).to_owned()))?;
        if text(&found, "mergedIntoId").is_some() {
            return Err(rejected(
                "merged",
                format!(
                    "Ticket #{} was merged into another one; link the kept ticket",
                    found["conversationNumber"]
                ),
            ));
        }
    }
    // The last refusal the links below can raise: with it, a 4xx never leaves
    // a problem behind.
    assert_open_for_incidents(status, conversation_ids.len())?;

    let id = generate_id("dprob");
    let now = webchat::now();
    let fresh = json!({ "status": "open" });
    let times = status_patch(&fresh, status, &now);
    let time = |prop: &str| {
        times
            .iter()
            .find(|(key, _)| *key == prop)
            .map_or(Value::Null, |(_, value)| value.clone())
    };

    for attempt in 0.. {
        let number: i64 = sqlx::query_scalar(
            "select (coalesce(max(problem_number), 0) + 1)::bigint from desk_problems",
        )
        .fetch_one(db)
        .await?;
        let mut values = Map::new();
        for (prop, value) in [
            ("id", json!(id)),
            ("createdAt", json!(now)),
            ("updatedAt", json!(now)),
            ("problemNumber", json!(number)),
            ("title", json!(js_trim(&input.title))),
            (
                "description",
                json!(text_or_null(input.description.as_deref())),
            ),
            ("status", json!(status)),
            ("priority", json!(input.priority)),
            ("rootCause", json!(root_cause)),
            ("workaround", json!(workaround)),
            ("assigneeId", json!(input.assignee_id)),
            ("departmentId", json!(input.department_id)),
            ("createdById", json!(author_id)),
            ("knownErrorAt", time("knownErrorAt")),
            ("resolvedAt", time("resolvedAt")),
            ("closedAt", time("closedAt")),
        ] {
            DESK_PROBLEMS.set(&mut values, prop, value);
        }
        match DESK_PROBLEMS.insert(db, values, &TRUSTED).await {
            Ok(_) => break,
            Err(error) if attempt < 4 && webchat::unique_violation(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }

    let mut changes = Vec::new();
    for conversation_id in conversation_ids {
        let linked = set_conversation_problem(db, author_id, conversation_id, Some(&id)).await?;
        changes.extend(linked.changes);
    }
    Ok(Created {
        problem: reload(db, &id).await?,
        changes,
    })
}

/// `DeskProblemPatch`: an absent field is left alone, null clears one.
#[derive(Debug, Default)]
pub struct Patch {
    pub title: Option<String>,
    pub description: Field<String>,
    pub status: Option<String>,
    pub priority: Field<String>,
    pub assignee_id: Field<String>,
    pub department_id: Field<String>,
    pub root_cause: Field<String>,
    pub workaround: Field<String>,
    pub resolution: Field<String>,
}

/// `UpdateDeskProblemResult`: the problem with its counts, and the fields
/// that changed (the status timestamps included) as `{ from, to }`.
#[derive(Debug)]
pub struct Updated {
    pub problem: Value,
    pub changes: Map<String, Value>,
}

/// `updateDeskProblem(db, input)`: nothing is written when nothing changes.
pub async fn update(db: &PgPool, id: &str, patch: &Patch) -> Result<Updated, ProblemError> {
    let current = load(db, id).await?;
    let current_id = current["id"].as_str().unwrap_or(id).to_owned();
    let mut next: Vec<(&'static str, Value)> = Vec::new();

    if let Some(title) = &patch.title {
        next.push(("title", json!(js_trim(title))));
    }
    for (prop, field) in [
        ("description", &patch.description),
        ("rootCause", &patch.root_cause),
        ("workaround", &patch.workaround),
        ("resolution", &patch.resolution),
    ] {
        match field {
            Field::Absent => {}
            Field::Null => next.push((prop, Value::Null)),
            Field::Set(text) => next.push((prop, json!(text_or_null(Some(text))))),
        }
    }
    for (prop, field) in [
        ("priority", &patch.priority),
        ("assigneeId", &patch.assignee_id),
        ("departmentId", &patch.department_id),
    ] {
        match field {
            Field::Absent => {}
            Field::Null => next.push((prop, Value::Null)),
            Field::Set(value) => next.push((prop, json!(value))),
        }
    }

    let status = patch
        .status
        .as_deref()
        .or_else(|| current["status"].as_str())
        .unwrap_or_default()
        .to_owned();
    if let Some(status) = &patch.status {
        next.push(("status", json!(status)));
        next.extend(status_patch(&current, status, &webchat::now()));
    }
    // `next.x === undefined ? current.x : next.x`.
    let after = |prop: &str| {
        next.iter()
            .find(|(key, _)| *key == prop)
            .map_or(&current[prop], |(_, value)| value)
    };
    assert_known_error_backed(
        &status,
        after("workaround").as_str(),
        after("rootCause").as_str(),
    )?;
    // Only an owner or a team the patch changes is checked.
    let replaced = |prop: &str| {
        next.iter()
            .find(|(key, value)| *key == prop && *value != current[prop])
            .and_then(|(_, value)| value.as_str())
    };
    assert_owner_and_team(db, replaced("assigneeId"), replaced("departmentId")).await?;

    let mut changes = Map::new();
    for (prop, value) in &next {
        if current[*prop] != *value {
            changes.insert(
                (*prop).to_owned(),
                json!({ "from": current[*prop], "to": value }),
            );
        }
    }
    if changes.is_empty() {
        return Ok(Updated {
            problem: reload(db, &current_id).await?,
            changes,
        });
    }

    let mut values = Map::new();
    for (prop, value) in next {
        DESK_PROBLEMS.set(&mut values, prop, value);
    }
    DESK_PROBLEMS.set(&mut values, "updatedAt", json!(webchat::now()));
    DESK_PROBLEMS
        .patch(db, &current_id, values, false, &TRUSTED)
        .await?;
    Ok(Updated {
        problem: reload(db, &current_id).await?,
        changes,
    })
}

/// `setDeskProblemArticle(db, id, articleId)`: link the help-center article
/// written from this problem. The problem with its counts.
pub async fn set_article(
    db: &PgPool,
    id: &str,
    article_id: Option<&str>,
) -> Result<Value, ProblemError> {
    load(db, id).await?;
    sqlx::query(
        "update desk_problems set article_id = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(article_id)
    .bind(webchat::now())
    .execute(db)
    .await?;
    reload(db, id).await
}

/// `deleteDeskProblem(db, id)`: delete a problem; its incidents are unlinked
/// quietly. The deleted row and how many incidents were unlinked.
pub async fn delete(db: &PgPool, id: &str) -> Result<(Value, usize), ProblemError> {
    let problem = load(db, id).await?;
    let unlinked: Vec<String> = sqlx::query_scalar(
        "update desk_conversations set problem_id = null where problem_id = $1 returning id",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    sqlx::query("delete from desk_problems where id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok((problem, unlinked.len()))
}

// ── sharing the workaround ────────────────────────────────────────────────────

/// `ShareDeskProblemWorkaroundResult`: the problem, one entry per open
/// incident (by number), and the open incidents past the cap that got
/// nothing.
#[derive(Debug)]
pub struct Shared {
    pub problem: Value,
    pub changes: Vec<Appended>,
    pub skipped: i64,
}

/// `shareDeskProblemWorkaround(db, input)`: one note (`note`) or agent reply
/// on each open incident (open, not merged away), with `metadata.problemId`.
/// `body` is what to post; the problem's workaround when absent. The caller
/// delivers each reply on its conversation's channel.
pub async fn share_workaround(
    db: &PgPool,
    author_id: Option<&str>,
    problem_id: &str,
    body: Option<&str>,
    note: bool,
) -> Result<Shared, ProblemError> {
    let problem = load(db, problem_id).await?;
    let Some(text) = text_or_null(body).or_else(|| text_or_null(problem["workaround"].as_str()))
    else {
        return Err(rejected(
            "workaround_required",
            "Write the workaround first, there is nothing to share",
        ));
    };
    let id = problem["id"].as_str().unwrap_or(problem_id).to_owned();
    let targets: Vec<String> = sqlx::query_scalar(
        "select t.id from desk_conversations t
          where t.problem_id = $1 and t.state = 'open' and t.merged_into_id is null
          order by t.conversation_number asc, t.id asc limit $2",
    )
    .bind(&id)
    .bind(MAX_CHILDREN)
    .fetch_all(db)
    .await?;
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from desk_conversations t
          where t.problem_id = $1 and t.state = 'open' and t.merged_into_id is null",
    )
    .bind(&id)
    .fetch_one(db)
    .await?;

    let mut changes = Vec::new();
    for target in &targets {
        let mut metadata = Map::new();
        metadata.insert("problemId".to_owned(), json!(id));
        changes.push(
            append(
                db,
                Append {
                    conversation_id: target,
                    kind: if note { "note" } else { "message" },
                    author_type: "agent",
                    author_id,
                    body: Some(text.clone()),
                    attachments: None,
                    metadata: Some(metadata),
                    assignee_id: None,
                },
            )
            .await?,
        );
    }
    let posted = i64::try_from(targets.len()).unwrap_or(i64::MAX);
    Ok(Shared {
        problem,
        changes,
        skipped: (i64::from(total) - posted).max(0),
    })
}

// ── article from a problem ────────────────────────────────────────────────────

/// What `deskArticleDraftFromProblem` writes into the article editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleDraft {
    pub title: String,
    pub content: String,
    pub excerpt: Option<String>,
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `section(heading, body)`: a heading and the text as one paragraph, its
/// lines kept apart; nothing for an empty text.
fn section(heading: &str, body: Option<&str>) -> String {
    let Some(text) = body.map(js_trim).filter(|text| !text.is_empty()) else {
        return String::new();
    };
    let lines = text.replace("\r\n", "\n").replace('\r', "\n");
    format!(
        "<h2>{}</h2><p>{}</p>",
        escape_html(heading),
        escape_html(&lines).replace('\n', "<br>")
    )
}

/// `text.replace(/[\r\n\t ]+/g, ' ').trim()`.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, '\r' | '\n' | '\t' | ' ') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `deskArticleDraftFromProblem(problem)`: the article editor's HTML for a
/// known error (symptoms, cause and workaround), its title and its excerpt
/// (the workaround's first 200 characters, else the description's).
pub fn article_draft(problem: &Value) -> ArticleDraft {
    let title: String = js_trim(problem["title"].as_str().unwrap_or_default())
        .chars()
        .take(200)
        .collect();
    let content = [
        section("Symptoms", problem["description"].as_str()),
        section("Cause", problem["rootCause"].as_str()),
        section("Workaround", problem["workaround"].as_str()),
    ]
    .concat();
    // `problem.workaround ?? problem.description`: an empty workaround still wins.
    let lead = problem["workaround"]
        .as_str()
        .or_else(|| problem["description"].as_str())
        .map(collapse)
        .filter(|lead| !lead.is_empty());
    ArticleDraft {
        title,
        content: if content.is_empty() {
            "<p></p>".to_owned()
        } else {
            content
        },
        excerpt: lead.map(|lead| lead.chars().take(200).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-10T09:00:00.000Z";
    const EARLIER: &str = "2026-11-01T08:00:00.000Z";

    fn patch_of(current: &Value, next: &str) -> Value {
        Value::Object(
            status_patch(current, next, NOW)
                .into_iter()
                .map(|(prop, value)| (prop.to_owned(), value))
                .collect(),
        )
    }

    #[test]
    fn a_status_move_stamps_and_clears_the_timestamps() {
        let open =
            json!({ "status": "open", "knownErrorAt": null, "resolvedAt": null, "closedAt": null });
        assert_eq!(patch_of(&open, "open"), json!({}));
        assert_eq!(
            patch_of(&open, "investigating"),
            json!({ "knownErrorAt": null, "resolvedAt": null, "closedAt": null })
        );
        assert_eq!(
            patch_of(&open, "known_error"),
            json!({ "knownErrorAt": NOW, "resolvedAt": null, "closedAt": null })
        );
        assert_eq!(
            patch_of(&open, "resolved"),
            json!({ "resolvedAt": NOW, "closedAt": null })
        );
        // Closed without ever being resolved: both at once.
        assert_eq!(
            patch_of(&open, "closed"),
            json!({ "closedAt": NOW, "resolvedAt": NOW })
        );
    }

    #[test]
    fn a_status_move_keeps_the_first_known_error_and_resolution_time() {
        let resolved = json!({
            "status": "resolved", "knownErrorAt": EARLIER, "resolvedAt": EARLIER, "closedAt": null,
        });
        assert_eq!(
            patch_of(&resolved, "closed"),
            json!({ "closedAt": NOW, "resolvedAt": EARLIER })
        );
        assert_eq!(
            patch_of(&resolved, "known_error"),
            json!({ "knownErrorAt": EARLIER, "resolvedAt": null, "closedAt": null })
        );
        assert_eq!(
            patch_of(&resolved, "open"),
            json!({ "knownErrorAt": null, "resolvedAt": null, "closedAt": null })
        );
    }

    #[test]
    fn a_known_error_needs_a_workaround_or_a_root_cause() {
        let refused = |workaround, root_cause| {
            matches!(
                assert_known_error_backed("known_error", workaround, root_cause),
                Err(ProblemError::Rejected {
                    reason: "workaround_required",
                    ..
                })
            )
        };
        assert!(refused(None, None));
        assert!(refused(Some("  "), Some("")));
        assert!(!refused(Some("Restart"), None));
        assert!(!refused(None, Some("Gateway timeout")));
        assert!(assert_known_error_backed("open", None, None).is_ok());
    }

    #[test]
    fn texts_are_trimmed_and_empty_ones_are_null() {
        assert_eq!(text_or_null(Some("  a b \n")).as_deref(), Some("a b"));
        assert_eq!(text_or_null(Some(" \t ")), None);
        assert_eq!(text_or_null(None), None);
    }

    #[test]
    fn a_merged_duplicate_and_a_closed_problem_are_refused() {
        let reason =
            |conversation: Value, problem: Value| match assert_linkable(&conversation, &problem) {
                Err(ProblemError::Rejected { reason, message }) => Some((reason, message)),
                _ => None,
            };
        let open = json!({ "status": "open", "problemNumber": 3 });
        let closed = json!({ "status": "closed", "problemNumber": 3 });
        assert_eq!(reason(json!({ "mergedIntoId": null }), open.clone()), None);
        assert_eq!(
            reason(json!({ "mergedIntoId": "dconv_1" }), open).map(|r| r.0),
            Some("merged")
        );
        assert_eq!(
            reason(json!({ "mergedIntoId": null }), closed),
            Some((
                "problem_closed",
                "Problem #3 is closed and takes no new incidents".to_owned()
            ))
        );
    }

    #[test]
    fn a_problem_created_closed_takes_no_incidents() {
        let reason = |status, incidents| match assert_open_for_incidents(status, incidents) {
            Err(ProblemError::Rejected { reason, message }) => Some((reason, message)),
            _ => None,
        };
        assert_eq!(
            reason("closed", 1),
            Some((
                "problem_closed",
                "A closed problem takes no incidents; link the tickets before closing it"
                    .to_owned()
            ))
        );
        assert_eq!(reason("closed", 0), None);
        assert_eq!(reason("resolved", 2), None);
        assert_eq!(reason("open", 2), None);
    }

    #[test]
    fn an_article_draft_has_symptoms_cause_and_workaround() {
        let draft = article_draft(&json!({
            "title": "  Checkout <fails> ",
            "description": "The pay button\r\ndoes nothing",
            "rootCause": "Gateway \"timeout\"",
            "workaround": " Use PayPal\n\tfor now ",
        }));
        assert_eq!(draft.title, "Checkout <fails>");
        assert_eq!(
            draft.content,
            "<h2>Symptoms</h2><p>The pay button<br>does nothing</p>\
             <h2>Cause</h2><p>Gateway &quot;timeout&quot;</p>\
             <h2>Workaround</h2><p>Use PayPal<br>\tfor now</p>"
        );
        assert_eq!(draft.excerpt.as_deref(), Some("Use PayPal for now"));
    }

    #[test]
    fn an_article_draft_without_text_is_an_empty_paragraph() {
        let draft = article_draft(&json!({
            "title": "é".repeat(300), "description": "Slow", "rootCause": null, "workaround": null,
        }));
        assert_eq!(draft.title.chars().count(), 200);
        assert_eq!(draft.content, "<h2>Symptoms</h2><p>Slow</p>");
        assert_eq!(draft.excerpt.as_deref(), Some("Slow"));
        // An empty workaround is not null, so the description is not the lead.
        let empty =
            article_draft(&json!({ "title": "x", "description": "Slow", "workaround": "" }));
        assert_eq!(empty.excerpt, None);
        let bare = article_draft(&json!({ "title": "x" }));
        assert_eq!(bare.content, "<p></p>");
        assert_eq!(bare.excerpt, None);
    }

    #[test]
    fn problem_links_stay_with_the_team() {
        for event in ["problem_linked", "problem_unlinked"] {
            let message = json!({ "kind": "event", "metadata": { "eventType": event } });
            assert!(!webchat::is_public(&message), "{event}");
        }
    }
}
