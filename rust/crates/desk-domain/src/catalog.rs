//! The service catalogue (`@weldsuite/db/lib/desk-catalog`,
//! `packages/core/db/src/lib/desk-catalog.ts`): request items, each with its
//! own form (a customer ticket type), approval steps and fulfilment tasks.
//! The only writer of `desk_catalog_items`, `desk_request_approvals` and
//! `desk_conversations.catalog_item_id` / `.approval_status`; every approval
//! step lands on the timeline as an internal event (`approval_requested`,
//! `approval_approved`, `approval_rejected`, `fulfilment_started`) through
//! [`webchat::append`].
//!
//! A request is an inbox conversation with `catalog_item_id` set: an agent
//! attaches an item to an existing conversation ([`start_request`], after
//! setting its type, team and priority). Starting copies the item's steps
//! into `desk_request_approvals` (the approver resolved to a user id at that
//! moment). Steps are decided in order: the first is `pending`, the rest
//! `waiting`. Approving the last step approves the request (fulfilment is
//! due); a rejection skips the remaining steps and rejects it. A request
//! without steps has `approval_status` null and fulfilment is due at once.
//!
//! Callers publish the changes, in order. Creating the fulfilment tasks and
//! notifying approvers is [`crate::fulfilment`]. The help center's side
//! (`listDeskCatalogForPrincipal`, `createDeskCatalogPortalRequest`) is not
//! here: the signed-in help center is not served by this backend yet.

#[rustfmt::skip]
#[path = "catalog_tables.rs"]
mod tables;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, js_trim};

use crate::attributes::PRIORITIES;
use crate::escalation::member_user_id;
use crate::table::WriteError;
use crate::webchat::{self, Append, AppendError, Appended, DESK_CONVERSATIONS};
pub use tables::{DESK_CATALOG_ITEMS, DESK_REQUEST_APPROVALS};

/// `DESK_CATALOG_APPROVER_TYPES`.
pub const APPROVER_TYPES: &[&str] = &["member", "team_manager"];
/// `DESK_CATALOG_MAX_APPROVAL_STEPS`.
pub const MAX_APPROVAL_STEPS: usize = 5;
/// `DESK_CATALOG_MAX_FULFILMENT_TASKS`.
pub const MAX_FULFILMENT_TASKS: usize = 20;

/// The timestamps the writers set themselves.
const TRUSTED: [&str; 3] = ["createdAt", "updatedAt", "decidedAt"];

// ── errors ────────────────────────────────────────────────────────────────────

/// Why a catalogue change stopped.
#[derive(Debug)]
pub enum CatalogError {
    /// `DeskConversationNotFoundError` for this id.
    ConversationNotFound(String),
    /// `DeskCatalogRejectedError`: an item that can't be saved, a 400 with
    /// `{ field }` (`ticketTypeId`, `approvalSteps`, …).
    Rejected {
        field: &'static str,
        message: String,
    },
    /// `DeskCatalogRefusedError`: a request that couldn't start or an
    /// approval that couldn't be decided, a 409 with `{ reason }`.
    Refused {
        reason: &'static str,
        message: &'static str,
    },
    Write(WriteError),
}

impl From<sqlx::Error> for CatalogError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

impl From<WriteError> for CatalogError {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConversationNotFound(id) => write!(f, "conversation {id} not found"),
            Self::Rejected { message, .. } => f.write_str(message),
            Self::Refused { message, .. } => f.write_str(message),
            Self::Write(error) => error.fmt(f),
        }
    }
}

fn rejected(field: &'static str, message: impl Into<String>) -> CatalogError {
    CatalogError::Rejected {
        field,
        message: message.into(),
    }
}

fn refused(reason: &'static str, message: &'static str) -> CatalogError {
    CatalogError::Refused { reason, message }
}

const ALREADY_REQUEST: &str = "This ticket is already a service request";

// ── items: the input ──────────────────────────────────────────────────────────

/// `DeskCatalogApprovalStepInput`.
#[derive(Debug, Default, Clone)]
pub struct StepInput {
    /// Kept when steps are reordered; generated when missing.
    pub id: Option<String>,
    pub name: Field<String>,
    pub approver_type: String,
    /// `member`: the approver's user id.
    pub approver_id: Field<String>,
    /// `team_manager`: the team whose manager approves; none uses the
    /// request's team.
    pub department_id: Field<String>,
}

/// `DeskCatalogFulfilmentTaskInput`.
#[derive(Debug, Default, Clone)]
pub struct TaskInput {
    pub id: Option<String>,
    pub title: String,
    pub description: Field<String>,
    /// A user id; none gives the task to the request's owner.
    pub assignee_id: Field<String>,
    /// Due this many days after approval.
    pub due_in_days: Field<i64>,
}

/// `DeskCatalogItemPatch` (and `DeskCatalogItemInput`, whose `name` and
/// `ticket_type_id` are always set): an absent field is left alone, null
/// clears one.
#[derive(Debug, Default, Clone)]
pub struct ItemInput {
    pub name: Option<String>,
    pub summary: Field<String>,
    pub description: Field<String>,
    pub category: Field<String>,
    pub icon: Field<String>,
    pub ticket_type_id: Option<String>,
    pub department_id: Field<String>,
    pub priority: Field<String>,
    pub delivery_estimate: Field<String>,
    pub approval_steps: Option<Vec<StepInput>>,
    pub fulfilment_tasks: Option<Vec<TaskInput>>,
    pub audience_company_ids: Option<Vec<String>>,
    pub is_active: Option<bool>,
    pub sort_order: Option<i64>,
}

/// `text(value)`: trimmed, `None` when nothing is left.
fn text(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `text(field)` of a field that may be left out: `None` is `undefined`
/// (the column is not written).
fn text_column(field: &Field<String>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(value) => Some(json!(text(Some(value)))),
    }
}

/// `activeMemberUserId(db, userId)`: an active internal member, by user id.
async fn active_member_user_id(db: &PgPool, user_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from workspace_members
          where user_id = $1 and deleted_at is null
            and upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL'
          limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// `assertTicketType(db, id)`: the form is an active customer ticket type
/// (`isCustomerType`).
async fn assert_ticket_type(db: &PgPool, id: &str) -> Result<(), CatalogError> {
    let usable: Option<bool> = sqlx::query_scalar(
        "select (is_active is distinct from false) and deleted_at is null
                and coalesce(category, 'customer') = 'customer'
           from helpdesk_ticket_types where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if usable == Some(true) {
        return Ok(());
    }
    Err(rejected(
        "ticketTypeId",
        "The form has to be an active customer ticket type",
    ))
}

/// `assertTeam(db, id, field)`: the team exists, is active and not deleted.
async fn assert_team(db: &PgPool, id: &str, field: &'static str) -> Result<(), CatalogError> {
    let usable: Option<bool> = sqlx::query_scalar(
        "select (is_active is distinct from false) and deleted_at is null
           from helpdesk_departments where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if usable == Some(true) {
        return Ok(());
    }
    Err(rejected(field, "This team does not exist or is not active"))
}

/// `step.id?.trim() || generateId(prefix)`.
fn id_or_new(id: Option<&str>, prefix: &str) -> String {
    id.map(js_trim)
        .filter(|id| !id.is_empty())
        .map_or_else(|| generate_id(prefix), str::to_owned)
}

/// `normalizeSteps(db, generateId, input)`: the steps as the item stores
/// them, each checked in order.
async fn normalize_steps(db: &PgPool, input: &[StepInput]) -> Result<Vec<Value>, CatalogError> {
    if input.len() > MAX_APPROVAL_STEPS {
        return Err(rejected(
            "approvalSteps",
            format!("At most {MAX_APPROVAL_STEPS} approval steps"),
        ));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(input.len());
    for step in input {
        if !APPROVER_TYPES.contains(&step.approver_type.as_str()) {
            return Err(rejected("approvalSteps", "Unknown approver type"));
        }
        let id = id_or_new(step.id.as_deref(), "dstep");
        if seen.contains(&id) {
            return Err(rejected(
                "approvalSteps",
                "Approval step ids must be unique",
            ));
        }
        seen.push(id.clone());
        let mut stored = Map::new();
        stored.insert("id".to_owned(), json!(id));
        if let Some(name) = text(step.name.as_set().map(String::as_str)) {
            stored.insert("name".to_owned(), json!(name));
        }
        if step.approver_type == "member" {
            let approver = text(step.approver_id.as_set().map(String::as_str));
            let member = match &approver {
                Some(approver) => active_member_user_id(db, approver).await?,
                None => None,
            };
            let (Some(approver), Some(_)) = (approver, member) else {
                return Err(rejected(
                    "approvalSteps",
                    "A member step needs an active member as approver",
                ));
            };
            stored.insert("approverType".to_owned(), json!("member"));
            stored.insert("approverId".to_owned(), json!(approver));
        } else {
            let department = text(step.department_id.as_set().map(String::as_str));
            if let Some(department) = &department {
                assert_team(db, department, "approvalSteps").await?;
            }
            stored.insert("approverType".to_owned(), json!("team_manager"));
            stored.insert("departmentId".to_owned(), json!(department));
        }
        out.push(Value::Object(stored));
    }
    Ok(out)
}

/// `normalizeTasks(generateId, input)`: the tasks as the item stores them.
fn normalize_tasks(input: &[TaskInput]) -> Result<Vec<Value>, CatalogError> {
    if input.len() > MAX_FULFILMENT_TASKS {
        return Err(rejected(
            "fulfilmentTasks",
            format!("At most {MAX_FULFILMENT_TASKS} fulfilment tasks"),
        ));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(input.len());
    for task in input {
        let Some(title) = text(Some(&task.title)) else {
            return Err(rejected(
                "fulfilmentTasks",
                "Every fulfilment task needs a title",
            ));
        };
        let id = id_or_new(task.id.as_deref(), "dtask");
        if seen.contains(&id) {
            return Err(rejected(
                "fulfilmentTasks",
                "Fulfilment task ids must be unique",
            ));
        }
        seen.push(id.clone());
        let mut stored = Map::new();
        stored.insert("id".to_owned(), json!(id));
        stored.insert("title".to_owned(), json!(title));
        if let Some(description) = text(task.description.as_set().map(String::as_str)) {
            stored.insert("description".to_owned(), json!(description));
        }
        stored.insert(
            "assigneeId".to_owned(),
            json!(text(task.assignee_id.as_set().map(String::as_str))),
        );
        stored.insert(
            "dueInDays".to_owned(),
            json!(task.due_in_days.as_set().copied()),
        );
        out.push(Value::Object(stored));
    }
    Ok(out)
}

/// `itemColumns(db, generateId, input)`: the columns an input writes (only
/// the keys it carries), validated, as `(property, value)`.
async fn item_columns(
    db: &PgPool,
    input: &ItemInput,
) -> Result<Vec<(&'static str, Value)>, CatalogError> {
    let mut columns: Vec<(&'static str, Value)> = Vec::new();
    if let Some(name) = &input.name {
        let Some(name) = text(Some(name)) else {
            return Err(rejected("name", "A name is required"));
        };
        columns.push(("name", json!(name)));
    }
    for (prop, field) in [
        ("summary", &input.summary),
        ("description", &input.description),
        ("category", &input.category),
        ("icon", &input.icon),
        ("deliveryEstimate", &input.delivery_estimate),
    ] {
        if let Some(value) = text_column(field) {
            columns.push((prop, value));
        }
    }
    if let Some(ticket_type_id) = &input.ticket_type_id {
        assert_ticket_type(db, ticket_type_id).await?;
        columns.push(("ticketTypeId", json!(ticket_type_id)));
    }
    if let Some(team) = text_column(&input.department_id) {
        if let Some(team_id) = team.as_str() {
            assert_team(db, team_id, "departmentId").await?;
        }
        columns.push(("departmentId", team));
    }
    match &input.priority {
        Field::Absent => {}
        Field::Null => columns.push(("priority", Value::Null)),
        Field::Set(priority) => {
            if !PRIORITIES.contains(&priority.as_str()) {
                return Err(rejected("priority", "Unknown priority"));
            }
            columns.push(("priority", json!(priority)));
        }
    }
    if let Some(steps) = &input.approval_steps {
        columns.push((
            "approvalSteps",
            Value::Array(normalize_steps(db, steps).await?),
        ));
    }
    if let Some(tasks) = &input.fulfilment_tasks {
        columns.push(("fulfilmentTasks", Value::Array(normalize_tasks(tasks)?)));
    }
    if let Some(ids) = &input.audience_company_ids {
        // `[...new Set(ids.map((id) => id.trim()).filter(Boolean))]`.
        let mut audience: Vec<&str> = Vec::new();
        for id in ids.iter().map(|id| js_trim(id)) {
            if !id.is_empty() && !audience.contains(&id) {
                audience.push(id);
            }
        }
        columns.push(("audienceCompanyIds", json!(audience)));
    }
    if let Some(active) = input.is_active {
        columns.push(("isActive", json!(active)));
    }
    if let Some(sort_order) = input.sort_order {
        columns.push(("sortOrder", json!(sort_order)));
    }
    Ok(columns)
}

// ── items: reading and writing ────────────────────────────────────────────────

/// `listDeskCatalogItems(db, { activeOnly })`: the catalogue in the
/// settings' order (sort order, then name); `active_only` leaves out
/// switched-off items.
pub async fn list_items(db: &PgPool, active_only: bool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_catalog_items t
          where (not $1::boolean or t.is_active = true)
          order by t.sort_order asc, t.name asc, t.id asc",
    )
    .bind(active_only)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DESK_CATALOG_ITEMS.js(row))
        .collect())
}

/// `getDeskCatalogItem(db, id)`.
pub async fn get_item(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    DESK_CATALOG_ITEMS.find_live(db, id).await
}

/// `createDeskCatalogItem(db, input)`: the new row.
pub async fn create_item(
    db: &PgPool,
    input: &ItemInput,
    created_by: Option<&str>,
) -> Result<Value, CatalogError> {
    let columns = item_columns(db, input).await?;
    let now = webchat::now();
    let mut values = Map::new();
    for (prop, value) in columns {
        DESK_CATALOG_ITEMS.set(&mut values, prop, value);
    }
    for (prop, value) in [
        ("id", json!(generate_id("dcat"))),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
        ("createdById", json!(created_by)),
    ] {
        DESK_CATALOG_ITEMS.set(&mut values, prop, value);
    }
    Ok(DESK_CATALOG_ITEMS.insert(db, values, &TRUSTED).await?)
}

/// `updateDeskCatalogItem(db, id, patch)`: change an item; only the keys
/// present change. `None` when it doesn't exist.
pub async fn update_item(
    db: &PgPool,
    id: &str,
    patch: &ItemInput,
) -> Result<Option<Value>, CatalogError> {
    if get_item(db, id).await?.is_none() {
        return Ok(None);
    }
    let columns = item_columns(db, patch).await?;
    let mut values = Map::new();
    for (prop, value) in columns {
        DESK_CATALOG_ITEMS.set(&mut values, prop, value);
    }
    DESK_CATALOG_ITEMS.set(&mut values, "updatedAt", json!(webchat::now()));
    Ok(DESK_CATALOG_ITEMS
        .patch(db, id, values, false, &TRUSTED)
        .await?)
}

/// `deleteDeskCatalogItem(db, id)`: delete an item. Requests made from it
/// keep their `catalog_item_id` and their approval rows. `None` when it
/// doesn't exist.
pub async fn delete_item(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "delete from desk_catalog_items t where t.id = $1 returning to_jsonb(t)",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_CATALOG_ITEMS.js(row)))
}

// ── starting a request ────────────────────────────────────────────────────────

/// `StartDeskCatalogRequestResult`.
#[derive(Debug)]
pub struct Started {
    pub conversation: Value,
    /// The timeline entries written, in order (empty without approval steps).
    pub changes: Vec<Appended>,
    /// The first step, now with its approver; `None` when the item needs no
    /// approval.
    pub pending_approval: Option<Value>,
    /// The item needs no approval: create its tasks now.
    pub fulfilment_due: bool,
}

fn truthy_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str().filter(|value| !value.is_empty())
}

/// `resolveApprover(db, step, conversation)`: who a step asks, as a user
/// id: its member, or the manager of its team (else the request's team).
async fn resolve_approver(
    db: &PgPool,
    step: &Value,
    conversation: &Value,
) -> Result<Option<String>, sqlx::Error> {
    if step["approverType"] == "member" {
        return match truthy_text(step, "approverId") {
            Some(approver) => active_member_user_id(db, approver).await,
            None => Ok(None),
        };
    }
    let Some(team_id) =
        truthy_text(step, "departmentId").or_else(|| truthy_text(conversation, "departmentId"))
    else {
        return Ok(None);
    };
    let manager: Option<Option<String>> = sqlx::query_scalar(
        "select manager_id from helpdesk_departments
          where id = $1 and deleted_at is null limit 1",
    )
    .bind(team_id)
    .fetch_optional(db)
    .await?;
    member_user_id(db, manager.flatten().as_deref()).await
}

/// Who decided a step and what they said (`decidedExtra`).
struct Decision<'a> {
    user_id: &'a str,
    comment: Option<&'a str>,
}

/// `approvalEvent(db, input)`: an internal event about `approval` on its
/// conversation's timeline.
async fn approval_event(
    db: &PgPool,
    event_type: &str,
    (author_type, author_id): (&str, Option<&str>),
    approval: &Value,
    item_name: &Value,
    decision: Option<&Decision<'_>>,
) -> Result<Appended, CatalogError> {
    let conversation_id = approval["conversationId"].as_str().unwrap_or_default();
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    for key in ["stepIndex", "stepName", "approverId", "catalogItemId"] {
        metadata.insert(key.to_owned(), approval[key].clone());
    }
    metadata.insert("catalogItemName".to_owned(), item_name.clone());
    if let Some(decision) = decision {
        metadata.insert("decidedById".to_owned(), json!(decision.user_id));
        metadata.insert("comment".to_owned(), json!(decision.comment));
    }
    append(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type,
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
async fn append(db: &PgPool, input: Append<'_>) -> Result<Appended, CatalogError> {
    let conversation_id = input.conversation_id.to_owned();
    webchat::append(db, input)
        .await
        .map_err(|error| match error {
            AppendError::NotFound => CatalogError::ConversationNotFound(conversation_id),
            AppendError::Write(error) => CatalogError::Write(error),
        })
}

/// `loadConversation(db, id)`.
async fn load_conversation(db: &PgPool, id: &str) -> Result<Value, CatalogError> {
    webchat::get(db, id, false)
        .await?
        .map(|(row, _)| row)
        .ok_or_else(|| CatalogError::ConversationNotFound(id.to_owned()))
}

/// `assertDeskRequestStartable(conversation)`: refuse a conversation that
/// can't become a service request (409 `reason`): `merged`,
/// `already_request`, `closed`. A caller that changes the conversation first
/// (the inbox sets the item's type and team) checks before.
pub fn assert_startable(conversation: &Value) -> Result<(), CatalogError> {
    if truthy_text(conversation, "mergedIntoId").is_some() {
        return Err(refused("merged", "This ticket was merged into another one"));
    }
    if truthy_text(conversation, "catalogItemId").is_some() {
        return Err(refused("already_request", ALREADY_REQUEST));
    }
    if conversation["state"] == "closed" {
        return Err(refused(
            "closed",
            "A closed ticket cannot become a service request",
        ));
    }
    Ok(())
}

/// `startDeskCatalogRequest(db, input)`: make an existing conversation a
/// service request of `item` and start its flow. `actor` is who started it
/// (the timeline event's author type and id). Refused (409 `reason`):
/// `already_request` (one item per conversation), `merged`, `closed`.
pub async fn start_request(
    db: &PgPool,
    conversation_id: &str,
    item: &Value,
    actor: (&str, Option<&str>),
) -> Result<Started, CatalogError> {
    let conversation = load_conversation(db, conversation_id).await?;
    assert_startable(&conversation)?;
    let id = conversation["id"]
        .as_str()
        .unwrap_or(conversation_id)
        .to_owned();
    let item_id = item["id"].as_str().unwrap_or_default();
    let steps: &[Value] = item["approvalSteps"].as_array().map_or(&[], Vec::as_slice);

    // Claim the conversation first: a second start at the same moment finds it taken.
    let claimed: Option<Value> = sqlx::query_scalar(
        "update desk_conversations t
            set catalog_item_id = $2, approval_status = $3, updated_at = $4::timestamp
          where t.id = $1 and t.catalog_item_id is null
          returning to_jsonb(t)",
    )
    .bind(&id)
    .bind(item_id)
    .bind((!steps.is_empty()).then_some("pending"))
    .bind(webchat::now())
    .fetch_optional(db)
    .await?;
    let Some(claimed) = claimed.map(|row| DESK_CONVERSATIONS.js(row)) else {
        return Err(refused("already_request", ALREADY_REQUEST));
    };

    if steps.is_empty() {
        return Ok(Started {
            conversation: claimed,
            changes: Vec::new(),
            pending_approval: None,
            fulfilment_due: true,
        });
    }

    let now = webchat::now();
    let mut first: Option<Value> = None;
    for (index, step) in steps.iter().enumerate() {
        let approver = resolve_approver(db, step, &claimed).await?;
        let mut values = Map::new();
        for (prop, value) in [
            ("id", json!(generate_id("dappr"))),
            ("createdAt", json!(now)),
            ("updatedAt", json!(now)),
            ("conversationId", json!(id)),
            ("catalogItemId", json!(item_id)),
            ("stepIndex", json!(index)),
            ("stepName", json!(step["name"].as_str())),
            ("approverId", json!(approver)),
            (
                "status",
                json!(if index == 0 { "pending" } else { "waiting" }),
            ),
        ] {
            DESK_REQUEST_APPROVALS.set(&mut values, prop, value);
        }
        let row = DESK_REQUEST_APPROVALS.insert(db, values, &TRUSTED).await?;
        if first.is_none() {
            first = Some(row);
        }
    }
    let Some(first) = first else {
        // Not reached: `steps` is not empty.
        return Err(refused("already_request", ALREADY_REQUEST));
    };
    let change =
        approval_event(db, "approval_requested", actor, &first, &item["name"], None).await?;
    Ok(Started {
        conversation: change.conversation.clone(),
        changes: vec![change],
        pending_approval: Some(first),
        fulfilment_due: false,
    })
}

// ── deciding ──────────────────────────────────────────────────────────────────

/// `DecideDeskRequestApprovalInput`.
#[derive(Debug, Clone, Copy)]
pub struct Decide<'a> {
    pub conversation_id: &'a str,
    /// The member deciding (a user id).
    pub user_id: &'a str,
    /// May decide any step: holds the catalogue's manage permission.
    pub can_manage: bool,
    /// `approved` or `rejected`.
    pub decision: &'a str,
    pub comment: Option<&'a str>,
}

/// `DecideDeskRequestApprovalResult`.
#[derive(Debug)]
pub struct Decided {
    pub conversation: Value,
    pub changes: Vec<Appended>,
    /// The step that went to its approver next (approve only); `None` when
    /// none did.
    pub next_approval: Option<Value>,
    /// The last step was approved: create the item's tasks.
    pub fulfilment_due: bool,
    /// The step that was decided.
    pub decided: Value,
}

/// `setApprovalStatus(db, conversationId, status)`.
async fn set_approval_status(
    db: &PgPool,
    conversation_id: &str,
    status: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update desk_conversations set approval_status = $2, updated_at = $3::timestamp
          where id = $1",
    )
    .bind(conversation_id)
    .bind(status)
    .bind(webchat::now())
    .execute(db)
    .await?;
    Ok(())
}

/// The first step of `conversation_id` in `status`, by step index.
async fn first_step(
    db: &PgPool,
    conversation_id: &str,
    status: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_request_approvals t
          where t.conversation_id = $1 and t.status = $2
          order by t.step_index asc limit 1",
    )
    .bind(conversation_id)
    .bind(status)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_REQUEST_APPROVALS.js(row)))
}

/// The decision on the `pending` step, written while it still is pending:
/// `None` when it was decided a moment ago.
async fn write_decision(
    db: &PgPool,
    pending: &Value,
    input: &Decide<'_>,
    comment: Option<&str>,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update desk_request_approvals t
            set status = $2, decided_at = $3::timestamp, decided_by_id = $4, comment = $5,
                updated_at = $3::timestamp
          where t.id = $1 and t.status = 'pending'
          returning to_jsonb(t)",
    )
    .bind(pending["id"].as_str())
    .bind(input.decision)
    .bind(now)
    .bind(input.user_id)
    .bind(comment)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_REQUEST_APPROVALS.js(row)))
}

/// The first waiting step, now with its approver (`pending`); `None` when
/// no step waits (or another decision opened it a moment ago).
async fn open_next_step(
    db: &PgPool,
    conversation_id: &str,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(waiting) = first_step(db, conversation_id, "waiting").await? else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(
        "update desk_request_approvals t
            set status = 'pending', updated_at = $2::timestamp
          where t.id = $1 and t.status = 'waiting'
          returning to_jsonb(t)",
    )
    .bind(waiting["id"].as_str())
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_REQUEST_APPROVALS.js(row)))
}

/// `decideDeskRequestApproval(db, input)`: decide the pending step of a
/// request. Only its approver may, or anyone who manages the catalogue (the
/// only way to decide a step without an approver). Refused (409 `reason`):
/// `not_pending` (nothing waits for a decision, or it was decided a moment
/// ago), `not_approver`.
pub async fn decide(db: &PgPool, input: Decide<'_>) -> Result<Decided, CatalogError> {
    load_conversation(db, input.conversation_id).await?;
    let Some(pending) = first_step(db, input.conversation_id, "pending").await? else {
        return Err(refused(
            "not_pending",
            "No approval is waiting for a decision",
        ));
    };
    if pending["approverId"].as_str() != Some(input.user_id) && !input.can_manage {
        return Err(refused(
            "not_approver",
            "Only the approver of this step can decide it",
        ));
    }

    let comment = text(input.comment);
    let now = webchat::now();
    let Some(decided) = write_decision(db, &pending, &input, comment.as_deref(), &now).await?
    else {
        return Err(refused("not_pending", "This approval was already decided"));
    };

    let item_name: Option<String> =
        sqlx::query_scalar("select name from desk_catalog_items where id = $1 limit 1")
            .bind(decided["catalogItemId"].as_str())
            .fetch_optional(db)
            .await?;
    let item_name = json!(item_name);
    let author = ("agent", Some(input.user_id));
    let decision = Decision {
        user_id: input.user_id,
        comment: comment.as_deref(),
    };
    let mut changes = Vec::new();

    if input.decision == "rejected" {
        sqlx::query(
            "update desk_request_approvals set status = 'skipped', updated_at = $2::timestamp
              where conversation_id = $1 and status = 'waiting'",
        )
        .bind(input.conversation_id)
        .bind(&now)
        .execute(db)
        .await?;
        set_approval_status(db, input.conversation_id, "rejected").await?;
        changes.push(
            approval_event(
                db,
                "approval_rejected",
                author,
                &decided,
                &item_name,
                Some(&decision),
            )
            .await?,
        );
        return Ok(Decided {
            conversation: last_conversation(&changes),
            changes,
            next_approval: None,
            fulfilment_due: false,
            decided,
        });
    }

    let next = open_next_step(db, input.conversation_id, &now).await?;
    if next.is_none() {
        set_approval_status(db, input.conversation_id, "approved").await?;
    }
    changes.push(
        approval_event(
            db,
            "approval_approved",
            author,
            &decided,
            &item_name,
            Some(&decision),
        )
        .await?,
    );
    if let Some(next) = &next {
        changes
            .push(approval_event(db, "approval_requested", author, next, &item_name, None).await?);
    }
    Ok(Decided {
        conversation: last_conversation(&changes),
        changes,
        fulfilment_due: next.is_none(),
        next_approval: next,
        decided,
    })
}

/// `lastConversation(changes)`: a decision always writes a timeline entry.
fn last_conversation(changes: &[Appended]) -> Value {
    changes
        .last()
        .map_or(Value::Null, |last| last.conversation.clone())
}

// ── reading a request ─────────────────────────────────────────────────────────

/// `DeskRequestApprovalView`: a step as the request view lists it, the row
/// without the request's own ids and its row timestamps.
fn approval_view(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "stepIndex": row["stepIndex"],
        "stepName": row["stepName"],
        "approverId": row["approverId"],
        "status": row["status"],
        "decidedAt": row["decidedAt"],
        "decidedById": row["decidedById"],
        "comment": row["comment"],
    })
}

/// `getDeskConversationRequest(db, conversationId)`: the service request a
/// conversation is (its item, null when it was deleted since, the approval
/// state and the steps in order); `None` when it isn't one or doesn't exist.
pub async fn conversation_request(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    #[allow(clippy::type_complexity)] // the item and the approval state
    let conversation: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select catalog_item_id, approval_status from desk_conversations where id = $1 limit 1",
    )
    .bind(conversation_id)
    .fetch_optional(db)
    .await?;
    let Some((Some(item_id), approval_status)) = conversation else {
        return Ok(None);
    };
    if item_id.is_empty() {
        return Ok(None);
    }
    let item: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'name', name, 'category', category, 'icon', icon,
                                   'deliveryEstimate', delivery_estimate)
           from desk_catalog_items where id = $1 limit 1",
    )
    .bind(&item_id)
    .fetch_optional(db)
    .await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_request_approvals t
          where t.conversation_id = $1
          order by t.step_index asc, t.id asc",
    )
    .bind(conversation_id)
    .fetch_all(db)
    .await?;
    let approvals: Vec<Value> = rows
        .into_iter()
        .map(|row| approval_view(&DESK_REQUEST_APPROVALS.js(row)))
        .collect();
    Ok(Some(json!({
        "item": item,
        "approvalStatus": approval_status,
        "approvals": approvals,
    })))
}

/// `listDeskPendingApprovals(db, { approverId, limit })`: steps waiting for
/// a decision, oldest first. `approver_id` limits them to one member's;
/// absent lists everyone's, steps without an approver included.
pub async fn pending_approvals(
    db: &PgPool,
    approver_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<(Value, Value, Option<String>)> = sqlx::query_as(
        "select to_jsonb(a), to_jsonb(c), i.name
           from desk_request_approvals a
          inner join desk_conversations c on c.id = a.conversation_id
           left join desk_catalog_items i on i.id = a.catalog_item_id
          where a.status = 'pending' and ($1::text is null or a.approver_id = $1)
          order by a.updated_at asc, a.id asc
          limit $2",
    )
    .bind(approver_id.filter(|id| !id.is_empty()))
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(approval, conversation, item_name)| {
            let approval = DESK_REQUEST_APPROVALS.js(approval);
            let conversation = DESK_CONVERSATIONS.js(conversation);
            // `name ?? email ?? null`.
            let requester = if conversation["name"].is_null() {
                &conversation["email"]
            } else {
                &conversation["name"]
            };
            json!({
                "approvalId": approval["id"],
                "conversationId": conversation["id"],
                "conversationNumber": conversation["conversationNumber"],
                "title": conversation["title"],
                "conversationCreatedAt": conversation["createdAt"],
                "catalogItemId": approval["catalogItemId"],
                "catalogItemName": item_name,
                "stepIndex": approval["stepIndex"],
                "stepName": approval["stepName"],
                "approverId": approval["approverId"],
                "requestedAt": approval["updatedAt"],
                "requesterName": requester,
            })
        })
        .collect())
}

// ── fulfilment ────────────────────────────────────────────────────────────────

/// `hasDeskFulfilmentStarted(db, conversationId)`: whether the request's
/// tasks were created already (a `fulfilment_started` event exists).
pub async fn fulfilment_started(db: &PgPool, conversation_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from desk_messages
          where conversation_id = $1 and kind = 'event'
            and metadata->>'eventType' = 'fulfilment_started'
          limit 1",
    )
    .bind(conversation_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `recordDeskRequestFulfilment(db, input)`: the internal
/// `fulfilment_started` event, naming the tasks that were created.
/// `author_id` is the member whose action started it; absent for the system.
pub async fn record_fulfilment(
    db: &PgPool,
    conversation_id: &str,
    author_id: Option<&str>,
    task_ids: &[String],
) -> Result<Appended, CatalogError> {
    let author_id = author_id.filter(|id| !id.is_empty());
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("fulfilment_started"));
    metadata.insert("taskIds".to_owned(), json!(task_ids));
    append(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type: if author_id.is_some() {
                "agent"
            } else {
                "system"
            },
            author_id,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(conversation: &Value) -> Option<&'static str> {
        match assert_startable(conversation) {
            Err(CatalogError::Refused { reason, .. }) => Some(reason),
            _ => None,
        }
    }

    #[test]
    fn a_merged_a_requested_and_a_closed_ticket_cannot_start() {
        assert_eq!(reason(&json!({ "state": "open" })), None);
        assert_eq!(
            reason(&json!({ "state": "open", "mergedIntoId": "", "catalogItemId": null })),
            None
        );
        // Merged wins over the rest, then the item, then the state.
        assert_eq!(
            reason(&json!({
                "state": "closed", "mergedIntoId": "dconv_1", "catalogItemId": "dcat_1",
            })),
            Some("merged")
        );
        assert_eq!(
            reason(&json!({ "state": "closed", "catalogItemId": "dcat_1" })),
            Some("already_request")
        );
        assert_eq!(reason(&json!({ "state": "closed" })), Some("closed"));
    }

    #[test]
    fn texts_are_trimmed_and_empty_ones_are_null() {
        assert_eq!(text(Some("  a b \n")).as_deref(), Some("a b"));
        assert_eq!(text(Some(" \t ")), None);
        assert_eq!(text(None), None);
        assert_eq!(text_column(&Field::Absent), None);
        assert_eq!(text_column(&Field::Null), Some(Value::Null));
        assert_eq!(text_column(&Field::Set("  ".to_owned())), Some(Value::Null));
        assert_eq!(text_column(&Field::Set(" x ".to_owned())), Some(json!("x")));
    }

    #[test]
    fn a_step_or_task_keeps_its_id_and_gets_one_when_it_has_none() {
        assert_eq!(id_or_new(Some(" s1 "), "dstep"), "s1");
        assert!(id_or_new(Some("  "), "dstep").starts_with("dstep_"));
        assert!(id_or_new(None, "dtask").starts_with("dtask_"));
    }

    #[test]
    fn tasks_are_stored_with_their_assignee_and_due_days() {
        let tasks = normalize_tasks(&[
            TaskInput {
                id: Some("t1".to_owned()),
                title: " Order it ".to_owned(),
                description: Field::Set("  ".to_owned()),
                assignee_id: Field::Set("user_a".to_owned()),
                due_in_days: Field::Set(3),
            },
            TaskInput {
                id: Some("t2".to_owned()),
                title: "Image it".to_owned(),
                description: Field::Set("With the base image".to_owned()),
                ..TaskInput::default()
            },
        ])
        .expect("valid");
        assert_eq!(
            json!(tasks),
            json!([
                { "id": "t1", "title": "Order it", "assigneeId": "user_a", "dueInDays": 3 },
                {
                    "id": "t2", "title": "Image it", "description": "With the base image",
                    "assigneeId": null, "dueInDays": null,
                },
            ])
        );
    }

    #[test]
    fn tasks_want_a_title_unique_ids_and_at_most_twenty() {
        let task = |id: &str, title: &str| TaskInput {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            ..TaskInput::default()
        };
        let message = |tasks: &[TaskInput]| match normalize_tasks(tasks) {
            Err(CatalogError::Rejected { field, message }) => Some((field, message)),
            _ => None,
        };
        assert_eq!(
            message(&[task("t", "A"), task("t", "B")]),
            Some((
                "fulfilmentTasks",
                "Fulfilment task ids must be unique".to_owned()
            ))
        );
        assert_eq!(
            message(&[task("t", "  ")]),
            Some((
                "fulfilmentTasks",
                "Every fulfilment task needs a title".to_owned()
            ))
        );
        let many: Vec<TaskInput> = (0..21).map(|i| task(&format!("t{i}"), "Task")).collect();
        assert_eq!(
            message(&many),
            Some(("fulfilmentTasks", "At most 20 fulfilment tasks".to_owned()))
        );
    }

    #[test]
    fn approval_events_stay_with_the_team() {
        for event in [
            "approval_requested",
            "approval_approved",
            "approval_rejected",
            "fulfilment_started",
        ] {
            let message = json!({ "kind": "event", "metadata": { "eventType": event } });
            assert!(!webchat::is_public(&message), "{event}");
        }
    }

    #[test]
    fn a_step_is_listed_with_eight_fields() {
        let view = approval_view(&json!({
            "id": "dappr_1", "createdAt": "x", "updatedAt": "y", "conversationId": "dconv_1",
            "catalogItemId": "dcat_1", "stepIndex": 0, "stepName": "Budget",
            "approverId": "user_a", "status": "pending", "decidedAt": null,
            "decidedById": null, "comment": null,
        }));
        let mut keys: Vec<&String> = view.as_object().expect("object").keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "approverId",
                "comment",
                "decidedAt",
                "decidedById",
                "id",
                "status",
                "stepIndex",
                "stepName"
            ]
        );
    }
}
