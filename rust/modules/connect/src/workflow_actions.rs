//! `/api/internal/workflow-actions/*` (connect-api's
//! `routes/internal-workflow-actions`): the WeldSuite records a WeldConnect
//! run writes, as the workflow's owner. `create-customer`,
//! `create-contact`, `update-contact`, `create-lead`, `create-deal`,
//! `move-deal-stage`, `log-activity`, `post-chat-message` and `create-task`.
//!
//! On Global the workflow worker calls them over a service binding; here
//! the engine calls [`perform`] in the process with the same body, and the
//! HTTP routes stay for anything else that calls them (behind
//! `INTERNAL_API_SECRET`). Both answer the route's own contract
//! (`{ success, ... }` / `{ success: false, error }`), so a step fails with
//! the message it does on Global.
//!
//! Every action checks the owner's permissions as they are now
//! (`services/workflow-owner.ts`): a refusal is a 403 the step does not
//! retry.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::response::{IntoResponse, Response};
use http::header::{AUTHORIZATION, CONTENT_TYPE};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    ACTIVITY_CREATED, CHAT_MESSAGE_CREATED, COMPANY_CREATED, LEAD_CREATED, OPPORTUNITY_CREATED,
    PERSON_CREATED, PERSON_UPDATED, PROJECT_TASK_CREATED,
};
use weldsuite_chat_domain::Realtime;
use weldsuite_chat_domain::text::{js_len, js_prefix, mention_bodies};
use weldsuite_crm_domain::DomainError;
use weldsuite_db::{PgPool, Tenant, TenantPermissionQueries, js_row};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType, iso_timestamp,
};
use weldsuite_kit::validation::{Format, Issues, Presence, Text, json_body};
use weldsuite_kit::{RequestEnv, generate_id};
use weldsuite_permissions::{
    AppCheckMode, ResolvedPermissions, check_app_permission, resolve_effective_permissions,
};
use weldsuite_ports::DynRealtimePublisher;

use crate::TenantDatabases;

// ── Contract ────────────────────────────────────────────────────────────────

/// An action's answer: the route's status and body.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

impl Answer {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    fn refused(status: u16, message: &str) -> Self {
        Self {
            status,
            body: json!({ "success": false, "error": message }),
        }
    }

    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.body)).into_response()
    }
}

/// The action routes, by their path under `/api/internal/workflow-actions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    CreateCustomer,
    CreateContact,
    UpdateContact,
    CreateLead,
    CreateDeal,
    MoveDealStage,
    LogActivity,
    PostChatMessage,
    CreateTask,
}

impl Action {
    /// The `label` `actionFailure` logs with.
    fn label(self) -> &'static str {
        match self {
            Self::CreateCustomer => "create-customer",
            Self::CreateContact => "create-contact",
            Self::UpdateContact => "update-contact",
            Self::CreateLead => "create-lead",
            Self::CreateDeal => "create-deal",
            Self::MoveDealStage => "move-deal-stage",
            Self::LogActivity => "log-activity",
            Self::PostChatMessage => "post-chat-message",
            Self::CreateTask => "create-task",
        }
    }
}

/// What an action writes with: the workspace's database, the event bus,
/// realtime (chat and notifications) and the master database (the
/// calendar re-plan's due index).
pub(crate) struct Performer<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) events: &'a EntityEventPublisher,
    pub(crate) realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub(crate) master: Option<&'a PgPool>,
    /// `PERMISSIONS_APP_ENFORCE === 'true'`.
    pub(crate) app_enforce: bool,
}

/// `zValidator('json', schema)` then the handler: the route's answer for a
/// body. The workspace's database is the performer's (the route opened it
/// from the body's `workspaceId`).
pub(crate) async fn perform(action: Action, performer: &Performer<'_>, body: &Value) -> Answer {
    match parse(action, body) {
        Ok(parsed) => run(action, parsed, performer).await,
        Err(answer) => answer,
    }
}

// ── Failures ────────────────────────────────────────────────────────────────

/// Why an action stopped: `actionFailure`'s three answers.
enum Failure {
    /// `WorkflowOwnerForbiddenError`: 403.
    Forbidden(String),
    /// `InvalidMemberIdError` (and the routes' own 400s): 400.
    BadRequest(String),
    /// Anything else: a 500 with the error's message.
    Internal(String),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<DomainError> for Failure {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::InvalidMemberId { message, .. } => Self::BadRequest(message),
            other => Self::Internal(other.message()),
        }
    }
}

impl Failure {
    fn answer(self, action: Action) -> Answer {
        match self {
            Self::Forbidden(message) => Answer::refused(403, &message),
            Self::BadRequest(message) => Answer::refused(400, &message),
            Self::Internal(message) => {
                tracing::error!(error = %message, "[Internal] Workflow {} failed", action.label());
                Answer::refused(500, &message)
            }
        }
    }
}

// ── The owner's permissions (`services/workflow-owner.ts`) ─────────────────

/// `authorizeWorkflowOwner(db, env, ownerUserId, { permission, app, doing })`.
async fn authorize_owner(
    performer: &Performer<'_>,
    owner: &str,
    permission: &str,
    app: &str,
    doing: &str,
) -> Result<ResolvedPermissions, Failure> {
    let queries = TenantPermissionQueries::new(performer.db.clone());
    let resolved = resolve_effective_permissions(&queries, owner).await?;
    if resolved.role.is_empty() {
        return Err(Failure::Forbidden(
            "The workflow's owner is no longer a member of this workspace, so it can't act for them"
                .to_owned(),
        ));
    }
    let in_app = check_app_permission(&resolved, permission, Some(app));
    let elsewhere = in_app.mode == AppCheckMode::App
        && check_app_permission(&resolved, permission, None).allowed;
    if !(in_app.allowed || (elsewhere && !performer.app_enforce)) {
        return Err(Failure::Forbidden(format!(
            "The workflow's owner doesn't have permission to {doing} ({permission})"
        )));
    }
    Ok(resolved)
}

/// `ownerHolds(resolved, permission, app)`.
fn owner_holds(resolved: &ResolvedPermissions, permission: &str, app: &str) -> bool {
    check_app_permission(resolved, permission, Some(app)).allowed
}

// ── Bodies ──────────────────────────────────────────────────────────────────

/// `actorSchema` (or create-customer's own head).
#[derive(Debug, Clone, Default)]
struct Actor {
    workspace_id: String,
    owner_user_id: String,
    chain_depth: i64,
}

enum Parsed {
    Customer {
        workspace_id: String,
        user_id: String,
        owner_user_id: Option<String>,
        chain_depth: i64,
        skip_if_email_exists: bool,
        customer: Map<String, Value>,
    },
    CreateContact {
        actor: Actor,
        skip_if_email_exists: bool,
        contact: Map<String, Value>,
    },
    UpdateContact {
        actor: Actor,
        contact_id: String,
        contact: Map<String, Value>,
    },
    Lead {
        actor: Actor,
        lead: Map<String, Value>,
    },
    Deal {
        actor: Actor,
        deal: Map<String, Value>,
    },
    MoveDeal {
        actor: Actor,
        deal_id: String,
        stage_id: String,
    },
    Activity {
        actor: Actor,
        activity: Map<String, Value>,
    },
    ChatMessage {
        actor: Actor,
        channel_id: String,
        content: String,
        mentions: Vec<String>,
        workflow_id: Option<String>,
        workflow_name: Option<String>,
    },
    Task {
        actor: Actor,
        project_id: String,
        task: Map<String, Value>,
    },
}

/// `z.string().trim().min(min).max(max)`.
const fn trimmed(min: usize, max: usize) -> Text {
    Text::trimmed(Some(min), Some(max))
}

/// Reads one body, collecting the field refinements (the email checks) to
/// settle after every synchronous check, as `safeParseAsync` does.
struct Reader<'i> {
    issues: &'i mut Issues,
    /// Paths of `.refine()` checks that failed.
    refused: Vec<Vec<Value>>,
    /// The nested object being read (`customer`, `contact`, …).
    within: Option<&'static str>,
}

impl Reader<'_> {
    /// `optionalTrimmed(max)`: `z.string().max(max).optional()`, then
    /// trimmed, `''` read as left out.
    fn optional(&mut self, body: &Map<String, Value>, key: &str, max: usize) -> Option<String> {
        self.issues
            .text_with(body, key, Presence::Optional, Text::length(None, Some(max)))
            .into_option()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    }

    /// `optionalTrimmed(255).refine(v => v === undefined || isEmail(v), 'Invalid email address')`:
    /// the refinement sees the trimmed value, or the raw one when `.max()`
    /// failed (Zod still runs it then).
    fn optional_email(&mut self, body: &Map<String, Value>, key: &str) -> Option<String> {
        let raw = body.get(key).and_then(Value::as_str).map(str::to_owned);
        let before = self.issues.count();
        let value = self.optional(body, key, 255);
        let checked = if self.issues.count() > before {
            raw
        } else {
            value.clone()
        };
        if let Some(text) = checked
            && !Format::Email.accepts(&text)
        {
            let mut path = Vec::new();
            if let Some(within) = self.within {
                path.push(json!(within));
            }
            path.push(json!(key));
            self.refused.push(path);
        }
        value
    }

    fn required(&mut self, body: &Map<String, Value>, key: &str, rules: Text) -> String {
        self.issues
            .text_with(body, key, Presence::Required, rules)
            .into_option()
            .unwrap_or_default()
    }

    /// `z.array(z.string().trim().min(1).max(max)).max(50).optional()`.
    fn list(&mut self, body: &Map<String, Value>, key: &str, max: usize) -> Option<Vec<String>> {
        self.issues
            .list(
                body,
                key,
                Presence::Optional,
                None,
                Some(50),
                |issues, item| issues.item_text(item, trimmed(1, max)),
            )
            .into_option()
    }

    /// The actor's head (`actorSchema`).
    fn actor(&mut self, body: &Map<String, Value>) -> Actor {
        let workspace_id = self.required(body, "workspaceId", Text::length(Some(1), None));
        let owner_user_id = self.required(body, "ownerUserId", Text::length(Some(1), None));
        self.required(body, "triggeredBy", Text::length(Some(1), None));
        let chain_depth = self.chain_depth(body);
        Actor {
            workspace_id,
            owner_user_id,
            chain_depth,
        }
    }

    /// `z.number().int().min(0).default(0)`.
    fn chain_depth(&mut self, body: &Map<String, Value>) -> i64 {
        self.issues
            .integer(body, "chainDepth", Presence::Optional, Some(0))
            .into_option()
            .unwrap_or(0)
    }

    /// `z.boolean().default(true)`.
    fn skip_if_email_exists(&mut self, body: &Map<String, Value>) -> bool {
        self.issues
            .boolean(body, "skipIfEmailExists", Presence::Optional)
            .into_option()
            .unwrap_or(true)
    }

    /// A required nested object read by `read` (an empty map when invalid).
    fn object(
        &mut self,
        body: &Map<String, Value>,
        key: &'static str,
        read: impl FnOnce(&mut Reader<'_>, &Map<String, Value>) -> Map<String, Value>,
    ) -> Map<String, Value> {
        let mut inner = Map::new();
        let mut refused = Vec::new();
        let _ = self
            .issues
            .nested(body, key, Presence::Required, |issues, fields| {
                let mut reader = Reader {
                    issues,
                    refused: Vec::new(),
                    within: Some(key),
                };
                inner = read(&mut reader, fields);
                refused = reader.refused;
            });
        self.refused.extend(refused);
        inner
    }
}

/// `{ key: value }` for the fields that are set (`undefined` is left out).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.into());
    }
}

/// `contactFieldsSchema`.
fn contact_fields(reader: &mut Reader<'_>, body: &Map<String, Value>) -> Map<String, Value> {
    let mut fields = Map::new();
    put(
        &mut fields,
        "firstName",
        reader.optional(body, "firstName", 100),
    );
    put(
        &mut fields,
        "lastName",
        reader.optional(body, "lastName", 100),
    );
    put(&mut fields, "email", reader.optional_email(body, "email"));
    put(&mut fields, "phone", reader.optional(body, "phone", 50));
    put(&mut fields, "title", reader.optional(body, "title", 100));
    put(
        &mut fields,
        "companyId",
        reader.optional(body, "companyId", 30),
    );
    put(&mut fields, "status", reader.optional(body, "status", 50));
    put(&mut fields, "notes", reader.optional(body, "notes", 10000));
    put(&mut fields, "tags", reader.list(body, "tags", 100));
    fields
}

/// `activityType`.
const ACTIVITY_TYPES: &[&str] = &[
    "call",
    "email",
    "meeting",
    "task",
    "note",
    "sms",
    "linkedin",
    "demo",
    "presentation",
];

fn parse_body(action: Action, reader: &mut Reader<'_>, body: &Map<String, Value>) -> Parsed {
    match action {
        Action::CreateCustomer => {
            let workspace_id = reader.required(body, "workspaceId", Text::length(Some(1), None));
            let user_id = reader.required(body, "userId", Text::length(Some(1), None));
            let owner_user_id = reader
                .issues
                .text_with(
                    body,
                    "ownerUserId",
                    Presence::Optional,
                    Text::length(Some(1), None),
                )
                .into_option();
            let chain_depth = reader.chain_depth(body);
            let skip_if_email_exists = reader.skip_if_email_exists(body);
            let customer = reader.object(body, "customer", |reader, body| {
                let mut fields = Map::new();
                put(
                    &mut fields,
                    "name",
                    Some(reader.required(body, "name", trimmed(1, 255))),
                );
                put(&mut fields, "email", reader.optional_email(body, "email"));
                put(&mut fields, "phone", reader.optional(body, "phone", 50));
                put(
                    &mut fields,
                    "website",
                    reader.optional(body, "website", 500),
                );
                put(&mut fields, "notes", reader.optional(body, "notes", 10000));
                put(&mut fields, "status", reader.optional(body, "status", 50));
                fields
            });
            Parsed::Customer {
                workspace_id,
                user_id,
                owner_user_id,
                chain_depth,
                skip_if_email_exists,
                customer,
            }
        }
        Action::CreateContact => {
            let actor = reader.actor(body);
            let skip_if_email_exists = reader.skip_if_email_exists(body);
            let contact = reader.object(body, "contact", contact_fields);
            Parsed::CreateContact {
                actor,
                skip_if_email_exists,
                contact,
            }
        }
        Action::UpdateContact => {
            let actor = reader.actor(body);
            let contact_id = reader.required(body, "contactId", trimmed(1, 30));
            let contact = reader.object(body, "contact", contact_fields);
            Parsed::UpdateContact {
                actor,
                contact_id,
                contact,
            }
        }
        Action::CreateLead => {
            let actor = reader.actor(body);
            let lead = reader.object(body, "lead", |reader, body| {
                let mut fields = Map::new();
                put(
                    &mut fields,
                    "firstName",
                    reader.optional(body, "firstName", 100),
                );
                put(
                    &mut fields,
                    "lastName",
                    reader.optional(body, "lastName", 100),
                );
                let email = Text {
                    trim: true,
                    lowercase: false,
                    format: Some(Format::Email),
                    min: None,
                    max: Some(255),
                };
                put(
                    &mut fields,
                    "email",
                    Some(reader.required(body, "email", email)),
                );
                put(
                    &mut fields,
                    "companyName",
                    reader.optional(body, "companyName", 255),
                );
                put(&mut fields, "title", reader.optional(body, "title", 100));
                put(&mut fields, "phone", reader.optional(body, "phone", 50));
                put(&mut fields, "mobile", reader.optional(body, "mobile", 50));
                put(
                    &mut fields,
                    "website",
                    reader.optional(body, "website", 500),
                );
                put(&mut fields, "source", reader.optional(body, "source", 50));
                put(&mut fields, "rating", reader.optional(body, "rating", 20));
                put(&mut fields, "notes", reader.optional(body, "notes", 10000));
                fields
            });
            Parsed::Lead { actor, lead }
        }
        Action::CreateDeal => {
            let actor = reader.actor(body);
            let deal = reader.object(body, "deal", |reader, body| {
                let mut fields = Map::new();
                put(
                    &mut fields,
                    "name",
                    Some(reader.required(body, "name", trimmed(1, 255))),
                );
                put(
                    &mut fields,
                    "customerId",
                    Some(reader.required(body, "customerId", trimmed(1, 30))),
                );
                put(
                    &mut fields,
                    "description",
                    reader.optional(body, "description", 5000),
                );
                put(
                    &mut fields,
                    "amount",
                    reader
                        .issues
                        .string_or_number(body, "amount", Presence::Optional)
                        .into_option(),
                );
                put(
                    &mut fields,
                    "currency",
                    reader.optional(body, "currency", 3),
                );
                put(
                    &mut fields,
                    "pipeline",
                    reader.optional(body, "pipeline", 100),
                );
                put(&mut fields, "stageId", reader.optional(body, "stageId", 30));
                put(
                    &mut fields,
                    "closeDate",
                    reader.optional(body, "closeDate", 50),
                );
                fields
            });
            Parsed::Deal { actor, deal }
        }
        Action::MoveDealStage => {
            let actor = reader.actor(body);
            let deal_id = reader.required(body, "dealId", trimmed(1, 30));
            let stage_id = reader.required(body, "stageId", trimmed(1, 30));
            Parsed::MoveDeal {
                actor,
                deal_id,
                stage_id,
            }
        }
        Action::LogActivity => {
            let actor = reader.actor(body);
            let activity = reader.object(body, "activity", |reader, body| {
                let mut fields = Map::new();
                put(
                    &mut fields,
                    "type",
                    reader
                        .issues
                        .choice(body, "type", Presence::Required, ACTIVITY_TYPES)
                        .into_option(),
                );
                put(
                    &mut fields,
                    "subject",
                    Some(reader.required(body, "subject", trimmed(1, 255))),
                );
                put(
                    &mut fields,
                    "description",
                    reader.optional(body, "description", 10000),
                );
                put(&mut fields, "dueDate", reader.optional(body, "dueDate", 50));
                put(
                    &mut fields,
                    "customerId",
                    reader.optional(body, "customerId", 30),
                );
                put(
                    &mut fields,
                    "contactId",
                    reader.optional(body, "contactId", 30),
                );
                put(
                    &mut fields,
                    "personId",
                    reader.optional(body, "personId", 30),
                );
                put(
                    &mut fields,
                    "opportunityId",
                    reader.optional(body, "opportunityId", 30),
                );
                fields
            });
            Parsed::Activity { actor, activity }
        }
        Action::PostChatMessage => {
            let actor = reader.actor(body);
            let channel_id = reader.required(body, "channelId", trimmed(1, 30));
            let content = reader.required(body, "content", trimmed(1, 10000));
            let mentions = reader.list(body, "mentions", 255).unwrap_or_default();
            let workflow_id = reader.optional(body, "workflowId", 30);
            let workflow_name = reader.optional(body, "workflowName", 255);
            Parsed::ChatMessage {
                actor,
                channel_id,
                content,
                mentions,
                workflow_id,
                workflow_name,
            }
        }
        Action::CreateTask => {
            let actor = reader.actor(body);
            let project_id = reader.required(body, "projectId", trimmed(1, 30));
            let task = reader.object(body, "task", |reader, body| {
                let mut fields = Map::new();
                put(
                    &mut fields,
                    "title",
                    Some(reader.required(body, "title", trimmed(1, 500))),
                );
                put(
                    &mut fields,
                    "description",
                    reader.optional(body, "description", 10000),
                );
                put(
                    &mut fields,
                    "priority",
                    reader.optional(body, "priority", 20),
                );
                put(&mut fields, "stageId", reader.optional(body, "stageId", 30));
                put(
                    &mut fields,
                    "assigneeIds",
                    reader.list(body, "assigneeIds", 30),
                );
                put(&mut fields, "dueDate", reader.optional(body, "dueDate", 50));
                put(&mut fields, "labels", reader.list(body, "labels", 100));
                put(&mut fields, "tags", reader.list(body, "tags", 100));
                fields
            });
            Parsed::Task {
                actor,
                project_id,
                task,
            }
        }
    }
}

/// `zValidator('json', schema)` on an already parsed body.
fn parse(action: Action, body: &Value) -> Result<Parsed, Answer> {
    let mut issues = Issues::default();
    let parsed = match issues.object(body) {
        Some(fields) => {
            let mut reader = Reader {
                issues: &mut issues,
                refused: Vec::new(),
                within: None,
            };
            let parsed = parse_body(action, &mut reader, fields);
            let refused = std::mem::take(&mut reader.refused);
            // Refinements settle after every synchronous check.
            for path in refused {
                issues.custom_at(&path, "Invalid email address");
            }
            Some(parsed)
        }
        None => None,
    };
    match (issues.finish(), parsed) {
        (Ok(()), Some(parsed)) => Ok(parsed),
        // The 400 `zValidator` answers: `{ success: false, error: ZodError }`.
        (Err(invalid), _) => Err(Answer {
            status: 400,
            body: json!({
                "success": false,
                "error": { "issues": invalid.issues(), "name": "ZodError" },
            }),
        }),
        (Ok(()), None) => Err(Answer::refused(500, "Unknown error")),
    }
}

// ── The actions ─────────────────────────────────────────────────────────────

/// `publishEntityEventRaw({ env, workspaceId, userId, entityType, action,
/// entityId, data, changes, workflowDepth })`, awaited.
#[allow(clippy::too_many_arguments)]
async fn publish(
    performer: &Performer<'_>,
    workspace_id: &str,
    user_id: &str,
    event: impl Into<EventType>,
    entity_id: &str,
    data: Value,
    changes: Option<Map<String, Value>>,
    depth: i64,
) {
    let mut entity = EntityEvent::new(event, entity_id, data)
        .with_workflow_depth(u32::try_from(depth).unwrap_or(0));
    if let Some(changes) = changes {
        entity = entity.with_changes(changes);
    }
    let context = EventContext::new(workspace_id, user_id, EventSource::System);
    performer.events.publish_and_wait(&context, entity).await;
}

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `personEventData(person)`.
fn person_event_data(person: &Value) -> Value {
    json!({
        "id": field(person, "id"),
        "firstName": field(person, "firstName"),
        "lastName": field(person, "lastName"),
        "fullName": field(person, "fullName"),
        "displayName": field(person, "displayName"),
        "email": field(person, "email"),
        "title": field(person, "title"),
    })
}

/// `personFields(fields)`: the contact's fields as the people service names them.
fn person_fields(contact: &Map<String, Value>) -> Map<String, Value> {
    let mut fields = Map::new();
    for (from, to) in [
        ("firstName", "firstName"),
        ("lastName", "lastName"),
        ("email", "email"),
        ("phone", "directPhone"),
        ("title", "title"),
        ("status", "status"),
        ("notes", "notes"),
        ("tags", "tags"),
    ] {
        if let Some(value) = contact.get(from) {
            fields.insert(to.to_owned(), value.clone());
        }
    }
    fields
}

async fn row_of(
    db: &PgPool,
    table_query: &'static str,
    id: &str,
) -> Result<Option<Value>, Failure> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(table_query))
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(js_row))
}

async fn run(action: Action, parsed: Parsed, performer: &Performer<'_>) -> Answer {
    let result = match parsed {
        Parsed::Customer {
            workspace_id,
            user_id,
            owner_user_id,
            chain_depth,
            skip_if_email_exists,
            customer,
        } => {
            create_customer(
                performer,
                &workspace_id,
                &user_id,
                owner_user_id.as_deref(),
                chain_depth,
                skip_if_email_exists,
                customer,
            )
            .await
        }
        Parsed::CreateContact {
            actor,
            skip_if_email_exists,
            contact,
        } => create_contact(performer, &actor, skip_if_email_exists, &contact).await,
        Parsed::UpdateContact {
            actor,
            contact_id,
            contact,
        } => update_contact(performer, &actor, &contact_id, &contact).await,
        Parsed::Lead { actor, lead } => create_lead(performer, &actor, lead).await,
        Parsed::Deal { actor, deal } => create_deal(performer, &actor, deal).await,
        Parsed::MoveDeal {
            actor,
            deal_id,
            stage_id,
        } => move_deal_stage(performer, &actor, &deal_id, &stage_id).await,
        Parsed::Activity { actor, activity } => log_activity(performer, &actor, activity).await,
        Parsed::ChatMessage {
            actor,
            channel_id,
            content,
            mentions,
            workflow_id,
            workflow_name,
        } => {
            post_chat_message(
                performer,
                &actor,
                &channel_id,
                &content,
                &mentions,
                workflow_id.as_deref(),
                workflow_name.as_deref(),
            )
            .await
        }
        Parsed::Task {
            actor,
            project_id,
            task,
        } => create_task(performer, &actor, &project_id, task).await,
    };
    result.unwrap_or_else(|failure| failure.answer(action))
}

/// `DEFAULT_WORKFLOW_CUSTOMER_STATUS`.
const DEFAULT_CUSTOMER_STATUS: &str = "active";

/// POST /create-customer.
async fn create_customer(
    performer: &Performer<'_>,
    workspace_id: &str,
    user_id: &str,
    owner_user_id: Option<&str>,
    chain_depth: i64,
    skip_if_email_exists: bool,
    customer: Map<String, Value>,
) -> Result<Answer, Failure> {
    let db = performer.db;
    if let Some(owner) = owner_user_id {
        authorize_owner(
            performer,
            owner,
            "companies:create",
            "weldcrm",
            "create companies",
        )
        .await?;
    }
    let acting = owner_user_id.unwrap_or(user_id);
    let email = customer.get("email").and_then(Value::as_str);

    // `findCompanyByEmail`.
    let existing = match email.filter(|_| skip_if_email_exists) {
        Some(email) => {
            sqlx::query_scalar::<_, Value>(
                "select to_jsonb(c) from companies c
                 where c.deleted_at is null and lower(c.email) = $1 limit 1",
            )
            .bind(email.to_lowercase())
            .fetch_optional(db)
            .await?
        }
        None => None,
    };
    let (created, company) = if let Some(row) = existing {
        (false, js_row(row))
    } else {
        // `isValidWorkspaceMember`: a schedule run's `system`, or someone
        // who left, leaves the owner unset.
        let owner_id = if !acting.is_empty() && acting != "system" {
            let member: Option<String> = sqlx::query_scalar(
                "select user_id from workspace_members where user_id = $1 and deleted_at is null limit 1",
            )
            .bind(acting)
            .fetch_optional(db)
            .await?;
            member.map(|_| acting.to_owned())
        } else {
            None
        };
        let mut input = Map::new();
        for key in ["name", "email", "phone", "website", "notes"] {
            if let Some(value) = customer.get(key) {
                input.insert(key.to_owned(), value.clone());
            }
        }
        input.insert(
            "status".into(),
            json!(
                customer
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_CUSTOMER_STATUS)
            ),
        );
        input.insert("source".into(), json!("weldconnect"));
        put(&mut input, "ownerId", owner_id);
        let company = weldsuite_crm_domain::companies::create_company(db, &input, None).await?;
        (true, company)
    };
    let id = company
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if created {
        publish(
            performer,
            workspace_id,
            acting,
            COMPANY_CREATED,
            id,
            json!({
                "id": id,
                "name": field(&company, "name"),
                "email": field(&company, "email"),
                "phone": field(&company, "phone"),
                "website": field(&company, "website"),
                "industry": field(&company, "industry"),
                "status": field(&company, "status"),
            }),
            None,
            chain_depth,
        )
        .await;
    }
    Ok(Answer::ok(json!({
        "success": true,
        "created": created,
        "customer": {
            "id": id,
            "name": field(&company, "name"),
            "email": field(&company, "email"),
            "status": field(&company, "status"),
        },
    })))
}

fn contact_answer(person: &Value, created: Option<bool>) -> Answer {
    let mut body = json!({
        "success": true,
        "contact": {
            "id": field(person, "id"),
            "displayName": field(person, "displayName"),
            "email": field(person, "email"),
        },
    });
    if let Some(created) = created {
        body["created"] = json!(created);
    }
    Answer::ok(body)
}

/// POST /create-contact.
async fn create_contact(
    performer: &Performer<'_>,
    actor: &Actor,
    skip_if_email_exists: bool,
    contact: &Map<String, Value>,
) -> Result<Answer, Failure> {
    let db = performer.db;
    let owner = actor.owner_user_id.as_str();
    authorize_owner(
        performer,
        owner,
        "people:create",
        "weldcrm",
        "create contacts",
    )
    .await?;
    let mut input = person_fields(contact);
    input.insert("ownerId".into(), json!(owner));
    input.insert("source".into(), json!("weldconnect"));
    if let Some(company_id) = contact.get("companyId").and_then(Value::as_str) {
        input.insert("companyIds".into(), json!([company_id]));
        input.insert("primaryCompanyId".into(), json!(company_id));
    }
    let person =
        match weldsuite_crm_domain::people::create_person_with(db, &input, !skip_if_email_exists)
            .await
        {
            Ok((person, _)) => {
                let id = person.get("id").and_then(Value::as_str).unwrap_or_default();
                publish(
                    performer,
                    &actor.workspace_id,
                    owner,
                    PERSON_CREATED,
                    id,
                    person_event_data(&person),
                    None,
                    actor.chain_depth,
                )
                .await;
                return Ok(contact_answer(&person, Some(true)));
            }
            Err(DomainError::DuplicateEmail {
                existing_person_id,
                message,
            }) => {
                match row_of(
                    db,
                    "select to_jsonb(p) from people p where p.id = $1 limit 1",
                    &existing_person_id,
                )
                .await?
                {
                    Some(existing) => existing,
                    None => return Err(Failure::Internal(message)),
                }
            }
            Err(other) => return Err(other.into()),
        };
    Ok(contact_answer(&person, Some(false)))
}

/// POST /update-contact.
async fn update_contact(
    performer: &Performer<'_>,
    actor: &Actor,
    contact_id: &str,
    contact: &Map<String, Value>,
) -> Result<Answer, Failure> {
    let owner = actor.owner_user_id.as_str();
    let resolved = authorize_owner(
        performer,
        owner,
        "people:update",
        "weldcrm",
        "edit contacts",
    )
    .await?;
    let scope = (!owner_holds(&resolved, "people:scope:all", "weldcrm")).then_some(owner);
    let fields = person_fields(contact);
    let Some((row, changes)) =
        weldsuite_crm_domain::people::update_person(performer.db, contact_id, &fields, scope)
            .await?
    else {
        return Ok(Answer::refused(
            404,
            &format!("Contact {contact_id} was not found (or the workflow's owner can't edit it)"),
        ));
    };
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
    publish(
        performer,
        &actor.workspace_id,
        owner,
        PERSON_UPDATED,
        id,
        person_event_data(&row),
        changes,
        actor.chain_depth,
    )
    .await;
    Ok(contact_answer(&row, None))
}

/// POST /create-lead.
async fn create_lead(
    performer: &Performer<'_>,
    actor: &Actor,
    mut lead: Map<String, Value>,
) -> Result<Answer, Failure> {
    let owner = actor.owner_user_id.as_str();
    authorize_owner(performer, owner, "leads:create", "weldcrm", "create leads").await?;
    lead.insert("ownerId".into(), json!(owner));
    let created =
        weldsuite_crm_domain::leads::create_lead(performer.db, &lead, Some(owner)).await?;
    let name = created
        .event_data
        .get("fullName")
        .cloned()
        .unwrap_or(Value::Null);
    let email = field(&created.event_data, "email");
    publish(
        performer,
        &actor.workspace_id,
        owner,
        LEAD_CREATED,
        &created.id,
        created.event_data,
        None,
        actor.chain_depth,
    )
    .await;
    Ok(Answer::ok(json!({
        "success": true,
        "lead": { "id": created.id, "name": name, "email": email },
    })))
}

/// POST /create-deal.
async fn create_deal(
    performer: &Performer<'_>,
    actor: &Actor,
    mut deal: Map<String, Value>,
) -> Result<Answer, Failure> {
    let owner = actor.owner_user_id.as_str();
    authorize_owner(
        performer,
        owner,
        "opportunities:create",
        "weldcrm",
        "create deals",
    )
    .await?;
    deal.insert("ownerId".into(), json!(owner));
    let created =
        weldsuite_crm_domain::opportunities::create_opportunity(performer.db, &deal, Some(owner))
            .await?;
    let answer = json!({
        "success": true,
        "deal": {
            "id": created.id,
            "name": field(&created.event_data, "name"),
            "stage": field(&created.event_data, "stage"),
            "status": field(&created.event_data, "status"),
        },
    });
    publish(
        performer,
        &actor.workspace_id,
        owner,
        OPPORTUNITY_CREATED,
        &created.id,
        created.event_data,
        None,
        actor.chain_depth,
    )
    .await;
    Ok(Answer::ok(answer))
}

/// POST /move-deal-stage.
async fn move_deal_stage(
    performer: &Performer<'_>,
    actor: &Actor,
    deal_id: &str,
    stage_id: &str,
) -> Result<Answer, Failure> {
    let owner = actor.owner_user_id.as_str();
    let resolved = authorize_owner(
        performer,
        owner,
        "opportunities:update",
        "weldcrm",
        "move deals",
    )
    .await?;
    let scope = (!owner_holds(&resolved, "opportunities:scope:all", "weldcrm")).then_some(owner);
    let moved = match weldsuite_crm_domain::opportunities::move_opportunity_stage(
        performer.db,
        deal_id,
        stage_id,
        scope,
    )
    .await
    {
        Ok(Some(moved)) => moved,
        Ok(None) => {
            return Ok(Answer::refused(
                404,
                &format!("Deal {deal_id} was not found (or the workflow's owner can't move it)"),
            ));
        }
        // `UnknownPipelineStageError`.
        Err(DomainError::BadRequest(message)) => return Err(Failure::BadRequest(message)),
        Err(other) => return Err(other.into()),
    };
    for event in moved.events {
        let event_type = EventType::catalog("opportunity", event.action)
            .map_err(|error| Failure::Internal(error.to_string()))?;
        publish(
            performer,
            &actor.workspace_id,
            owner,
            event_type,
            deal_id,
            event.data,
            None,
            actor.chain_depth,
        )
        .await;
    }
    let stage = match moved.row.get("stageId") {
        Some(Value::Null) | None => json!(stage_id),
        Some(value) => value.clone(),
    };
    Ok(Answer::ok(json!({
        "success": true,
        "deal": {
            "id": deal_id,
            "stageId": stage,
            "status": moved.row.get("status").cloned().unwrap_or(Value::Null),
        },
    })))
}

/// POST /log-activity.
async fn log_activity(
    performer: &Performer<'_>,
    actor: &Actor,
    mut activity: Map<String, Value>,
) -> Result<Answer, Failure> {
    let owner = actor.owner_user_id.as_str();
    authorize_owner(
        performer,
        owner,
        "activities:create",
        "weldcrm",
        "log activities",
    )
    .await?;
    activity.insert("assignedToId".into(), json!(owner));
    let created =
        weldsuite_crm_domain::activities::create_activity(performer.db, &activity, Some(owner))
            .await?;
    let answer = json!({
        "success": true,
        "activity": {
            "id": created.id,
            "type": field(&created.event_data, "type"),
            "subject": field(&created.event_data, "subject"),
        },
    });
    publish(
        performer,
        &actor.workspace_id,
        owner,
        ACTIVITY_CREATED,
        &created.id,
        created.event_data,
        None,
        actor.chain_depth,
    )
    .await;
    Ok(Answer::ok(answer))
}

// ── post-chat-message (`postSystemChatMessage`) ─────────────────────────────

/// `SEARCH_ENTITY_TYPES`: entity references in `<@type:id>`.
const SEARCH_ENTITY_TYPES: [&str; 14] = [
    "contact",
    "customer",
    "lead",
    "opportunity",
    "ticket",
    "article",
    "product",
    "order",
    "invoice",
    "bill",
    "project",
    "task",
    "sheet",
    "domain",
];

/// `extractChatMentions(content, extra)`.
fn extract_chat_mentions(content: &str, extra: &[String]) -> Vec<String> {
    let mut found: Vec<String> = extra.to_vec();
    for body in mention_bodies(content) {
        let (id, had_colon) = body
            .split_once(':')
            .map_or((body.as_str(), false), |(id, _)| (id, true));
        if !id.is_empty()
            && id != "everyone"
            && !id.starts_with("entity:")
            && (!had_colon || !SEARCH_ENTITY_TYPES.contains(&id))
            && !found.iter().any(|f| f == id)
        {
            found.push(id.to_owned());
        }
    }
    found
}

/// `isNotifiableMention`.
fn is_notifiable_mention(id: &str) -> bool {
    id != "everyone" && id != "entity" && !id.starts_with("entity:") && !id.starts_with("agt_")
}

/// POST /post-chat-message.
#[allow(clippy::too_many_arguments)]
async fn post_chat_message(
    performer: &Performer<'_>,
    actor: &Actor,
    channel_id: &str,
    content: &str,
    mentions: &[String],
    workflow_id: Option<&str>,
    workflow_name: Option<&str>,
) -> Result<Answer, Failure> {
    let db = performer.db;
    let owner = actor.owner_user_id.as_str();
    let org_id = actor.workspace_id.as_str();
    authorize_owner(
        performer,
        owner,
        "channels:create",
        "weldchat",
        "post chat messages",
    )
    .await?;
    if !weldsuite_chat_domain::can_access_channel(db, channel_id, owner, None).await? {
        return Ok(Answer::refused(
            403,
            "The workflow's owner doesn't have access to this channel",
        ));
    }
    let author_id = format!("workflow:{}", workflow_id.unwrap_or(org_id));
    let author_name = workflow_name.unwrap_or("Workflow");

    let id = generate_id("msg");
    let now = iso_timestamp(OffsetDateTime::now_utc());
    let all_mentions = extract_chat_mentions(content, mentions);
    let mentions_everyone = all_mentions.iter().any(|m| m == "everyone");
    sqlx::query(
        "insert into chat_messages (id, channel_id, author_id, author_name, author_type, content,
           mentions, mentions_everyone, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, 'system', $5, $6, $7, '{\"postedByWorkflow\":true}'::jsonb,
           $8::timestamp, $8::timestamp)",
    )
    .bind(&id)
    .bind(channel_id)
    .bind(&author_id)
    .bind(author_name)
    .bind(content)
    .bind((!all_mentions.is_empty()).then(|| json!(all_mentions)))
    .bind(mentions_everyone)
    .bind(&now)
    .execute(db)
    .await?;
    let preview = if js_len(content) > 100 {
        format!("{}...", js_prefix(content, 100))
    } else {
        content.to_owned()
    };
    sqlx::query(
        "update chat_channels set last_message_at = $2::timestamp, last_message_preview = $3,
           message_count = message_count + 1, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(channel_id)
    .bind(&now)
    .bind(&preview)
    .execute(db)
    .await?;

    let realtime = Realtime::new(performer.realtime.clone());
    if realtime.is_on() {
        let mut message = Map::new();
        message.insert("id".into(), json!(id));
        message.insert("content".into(), json!(content));
        message.insert("senderId".into(), json!(author_id));
        message.insert("senderName".into(), json!(author_name));
        message.insert("authorType".into(), json!("system"));
        realtime.message(channel_id, message).await;
        // `fanOutUnreadUpdates`: every human member.
        match sqlx::query_as::<_, (String, Option<String>)>(
            "select user_id, member_type from chat_channel_members where channel_id = $1",
        )
        .bind(channel_id)
        .fetch_all(db)
        .await
        {
            Ok(members) => {
                for (user_id, member_type) in members {
                    if member_type.as_deref() == Some("agent") {
                        continue;
                    }
                    realtime
                        .unread_update(org_id, &user_id, channel_id, 1)
                        .await;
                }
            }
            Err(error) => {
                tracing::error!(%error, "[chat-domain] workflow message unread fan-out failed");
            }
        }
    }

    // `notifyMentionedUsers`.
    let notifier = weldsuite_notifications::Notifier {
        realtime: performer.realtime.clone(),
        ..weldsuite_notifications::Notifier::default()
    };
    for mentioned in all_mentions.iter().filter(|m| is_notifiable_mention(m)) {
        if let Err(error) = sqlx::query(
            "update chat_channel_members set unread_mention_count = unread_mention_count + 1
             where channel_id = $1 and user_id = $2",
        )
        .bind(channel_id)
        .bind(mentioned)
        .execute(db)
        .await
        {
            tracing::error!(%error, "[chat-domain] workflow mention count increment failed");
        }
        if realtime.is_on() {
            realtime
                .chat_user(
                    org_id,
                    mentioned,
                    "mention",
                    json!({
                        "channelId": channel_id,
                        "messageId": id,
                        "authorName": author_name,
                        "preview": preview,
                    }),
                )
                .await;
        }
        let params = weldsuite_notifications::chat::mention(
            org_id,
            mentioned,
            owner,
            author_name,
            channel_id,
            &id,
            &preview,
        );
        if let Err(error) =
            weldsuite_notifications::create_and_deliver(db, &notifier, &params).await
        {
            tracing::error!(%error, "[chat-domain] workflow mention notification failed");
        }
    }

    publish(
        performer,
        org_id,
        owner,
        CHAT_MESSAGE_CREATED,
        &id,
        json!({ "id": id, "channelId": channel_id, "authorId": author_id, "authorType": "system" }),
        None,
        actor.chain_depth,
    )
    .await;
    Ok(Answer::ok(json!({
        "success": true,
        "message": { "id": id, "channelId": channel_id },
    })))
}

// ── create-task ─────────────────────────────────────────────────────────────

/// An ISO timestamp as epoch milliseconds (`new Date(value)`).
#[allow(clippy::cast_precision_loss)]
fn millis(value: Option<&Value>) -> Option<f64> {
    let text = value?.as_str()?;
    let at = OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some((at.unix_timestamp_nanos() / 1_000_000) as f64)
}

fn text_of<'v>(row: &'v Value, key: &str) -> Option<&'v str> {
    row.get(key).and_then(Value::as_str)
}

/// POST /create-task.
async fn create_task(
    performer: &Performer<'_>,
    actor: &Actor,
    project_id: &str,
    task: Map<String, Value>,
) -> Result<Answer, Failure> {
    let db = performer.db;
    let owner = actor.owner_user_id.as_str();
    let resolved =
        authorize_owner(performer, owner, "tasks:create", "weldflow", "create tasks").await?;
    let scope_all = owner_holds(&resolved, "projects:scope:all", "weldflow");
    let access = weldsuite_flow_domain::access::resolve_project_access(
        db,
        Some(owner),
        scope_all,
        project_id,
    )
    .await?;
    if !access.can_write {
        return Err(Failure::Forbidden(
            "The workflow's owner does not have write access to this project".to_owned(),
        ));
    }
    let created = weldsuite_flow_domain::tasks::create_task(db, &task, Some(project_id), owner)
        .await
        .map_err(|error| Failure::Internal(error.to_string()))?;
    let row = created.row;
    let id = text_of(&row, "id").unwrap_or_default().to_owned();
    let title = text_of(&row, "title").unwrap_or_default().to_owned();

    // The calendar auto-schedule, as flow-api's create does.
    let event = weldsuite_calendar_domain::TaskEvent {
        user_id: owner.to_owned(),
        source_id: Some(id.clone()),
        source_type: None,
        title: title.clone(),
        description: text_of(&row, "description").map(str::to_owned),
        due_date: millis(row.get("dueDate")),
        start_date: millis(row.get("startDate")),
        duration_minutes: row.get("duration").and_then(Value::as_f64),
        priority: text_of(&row, "priority").map(str::to_owned),
    };
    match weldsuite_calendar_domain::create_calendar_event_for_task(db, &event).await {
        Ok(Some(event_id)) => {
            if let Err(error) = sqlx::query("update tasks set calendar_event_id = $2 where id = $1")
                .bind(&id)
                .bind(&event_id)
                .execute(db)
                .await
            {
                tracing::error!(%error, "[connect-api] workflow create_task calendar auto-schedule failed");
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "[connect-api] workflow create_task calendar auto-schedule failed");
        }
    }
    if let Some(master) = performer.master {
        let workspace_id = actor.workspace_id.clone();
        weldsuite_db::due_index::sync_due(
            master,
            weldsuite_calendar_domain::REPLAN_KIND,
            &workspace_id,
            || weldsuite_calendar_domain::next_auto_scheduled_replan_at(db),
        )
        .await;
    }

    let now_ms = i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default();
    publish(
        performer,
        &actor.workspace_id,
        owner,
        PROJECT_TASK_CREATED,
        &id,
        weldsuite_flow_domain::analytics::task_analytics_payload(
            &row,
            &json!({ "projectId": project_id }),
            now_ms,
        ),
        None,
        actor.chain_depth,
    )
    .await;

    assignment_notifications(performer, actor, &created.assignee_ids, &row, project_id).await;

    let number = row.get("number").cloned().unwrap_or(Value::Null);
    let project = match row.get("projectId") {
        Some(Value::String(p)) => json!(p),
        _ => json!(project_id),
    };
    Ok(Answer::ok(json!({
        "success": true,
        "task": { "id": id, "number": number, "projectId": project, "title": title },
    })))
}

/// `sendTaskAssignmentNotificationsForWorkflow`: in-app (and push)
/// notifications to each assignee but the owner; connect-api has no mail
/// binding, so no email goes out.
async fn assignment_notifications(
    performer: &Performer<'_>,
    actor: &Actor,
    assignees: &[String],
    row: &Value,
    project_id: &str,
) {
    if assignees.is_empty() {
        return;
    }
    let db = performer.db;
    let owner = actor.owner_user_id.as_str();
    let task_id = text_of(row, "id").unwrap_or_default();
    let title = text_of(row, "title").unwrap_or_default();
    let notifier = weldsuite_notifications::Notifier {
        realtime: performer.realtime.clone(),
        ..weldsuite_notifications::Notifier::default()
    };
    for assignee in assignees {
        if assignee == owner {
            continue;
        }
        let assigner: Option<Option<String>> = match sqlx::query_scalar(
            "select name from workspace_members where user_id = $1 limit 1",
        )
        .bind(owner)
        .fetch_optional(db)
        .await
        {
            Ok(name) => name,
            Err(error) => {
                tracing::error!(%error, "[Notifications] Failed to resolve assigner name");
                None
            }
        };
        let assigner = assigner
            .flatten()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Someone".to_owned());
        let params = weldsuite_notifications::NewNotification {
            workspace_id: actor.workspace_id.clone(),
            user_id: assignee.clone(),
            title: "Task assigned to you".to_owned(),
            body: format!("{assigner} assigned \"{title}\" to you"),
            category: "projects".to_owned(),
            notification_type: "task_assigned".to_owned(),
            entity_type: "task".to_owned(),
            entity_id: task_id.to_owned(),
            action_url: format!("/weldflow/task/{task_id}"),
            severity: "info".to_owned(),
            actor_type: Some("user".to_owned()),
            actor_id: Some(owner.to_owned()),
            data: vec![
                ("taskId".to_owned(), task_id.to_owned()),
                ("projectId".to_owned(), project_id.to_owned()),
            ],
            ..weldsuite_notifications::NewNotification::default()
        };
        if let Err(error) =
            weldsuite_notifications::create_and_deliver(db, &notifier, &params).await
        {
            tracing::error!(%error, "[connect-api] workflow create_task assignment notification failed");
        }
    }
}

// ── The routes ──────────────────────────────────────────────────────────────

/// What the internal routes share: the event bus, realtime, the master
/// database, the workspaces' databases and the env (`INTERNAL_API_SECRET`,
/// `PERMISSIONS_APP_ENFORCE`).
#[derive(Clone)]
pub struct WorkflowActionsState {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub master: Option<PgPool>,
    pub tenants: Option<TenantDatabases>,
    pub env: Arc<HashMap<String, String>>,
}

/// The request's conformance overrides: the test's env, tenant and master.
struct Context {
    env: Option<RequestEnv>,
    tenant: Option<PgPool>,
    master: Option<PgPool>,
}

impl<S: Send + Sync> FromRequestParts<S> for Context {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            env: parts.extensions.get::<RequestEnv>().cloned(),
            tenant: parts.extensions.get::<Tenant>().map(|t| t.db.clone()),
            master: parts
                .extensions
                .get::<weldsuite_db::MasterDb>()
                .map(|m| m.0.clone()),
        }))
    }
}

impl Context {
    fn env(&self, state: &WorkflowActionsState, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => state.env.get(name).cloned(),
        }
    }
}

fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// The shared-secret bearer every route checks (`INTERNAL_API_SECRET`).
fn refuse_caller(
    state: &WorkflowActionsState,
    context: &Context,
    headers: &HeaderMap,
) -> Option<Response> {
    let Some(secret) = context
        .env(state, "INTERNAL_API_SECRET")
        .filter(|s| !s.is_empty())
    else {
        tracing::error!("[Internal API] INTERNAL_API_SECRET is not configured");
        return Some(error_body(
            StatusCode::SERVICE_UNAVAILABLE,
            "Internal auth not configured",
        ));
    };
    let header = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    let Some(token) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return Some(error_body(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Authorization header",
        ));
    };
    if !crate::public_webhook::constant_time_equal(token, &secret) {
        return Some(error_body(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    None
}

async fn handle(
    action: Action,
    state: WorkflowActionsState,
    context: Context,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(refused) = refuse_caller(&state, &context, &headers) {
        return refused;
    }
    let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok());
    let body = match json_body(content_type, &body) {
        Ok(body) => body,
        Err(malformed) => return malformed.into_response(),
    };
    let parsed = match parse(action, &body) {
        Ok(parsed) => parsed,
        Err(answer) => return answer.into_response(),
    };
    let workspace_id = match &parsed {
        Parsed::Customer { workspace_id, .. } => workspace_id.clone(),
        Parsed::CreateContact { actor, .. }
        | Parsed::UpdateContact { actor, .. }
        | Parsed::Lead { actor, .. }
        | Parsed::Deal { actor, .. }
        | Parsed::MoveDeal { actor, .. }
        | Parsed::Activity { actor, .. }
        | Parsed::ChatMessage { actor, .. }
        | Parsed::Task { actor, .. } => actor.workspace_id.clone(),
    };
    // `getTenantDbForWorkspace(c.env, workspaceId)`; conformance hands in
    // the test's database.
    let db = match context.tenant.clone() {
        Some(db) => db,
        None => match &state.tenants {
            Some(open) => match open(workspace_id).await {
                Ok(db) => db,
                Err(message) => return Failure::Internal(message).answer(action).into_response(),
            },
            None => {
                return Failure::Internal("No tenant databases".to_owned())
                    .answer(action)
                    .into_response();
            }
        },
    };
    let master = context.master.clone().or_else(|| {
        if context.env.is_some() {
            None
        } else {
            state.master.clone()
        }
    });
    let performer = Performer {
        db: &db,
        events: &state.events,
        realtime: state.realtime.clone(),
        master: master.as_ref(),
        app_enforce: context.env(&state, "PERMISSIONS_APP_ENFORCE").as_deref() == Some("true"),
    };
    run(action, parsed, &performer).await.into_response()
}

macro_rules! action_route {
    ($name:ident, $action:expr) => {
        async fn $name(
            State(state): State<WorkflowActionsState>,
            context: Context,
            headers: HeaderMap,
            body: Bytes,
        ) -> Response {
            handle($action, state, context, headers, body).await
        }
    };
}

action_route!(create_customer_route, Action::CreateCustomer);
action_route!(create_contact_route, Action::CreateContact);
action_route!(update_contact_route, Action::UpdateContact);
action_route!(create_lead_route, Action::CreateLead);
action_route!(create_deal_route, Action::CreateDeal);
action_route!(move_deal_stage_route, Action::MoveDealStage);
action_route!(log_activity_route, Action::LogActivity);
action_route!(post_chat_message_route, Action::PostChatMessage);
action_route!(create_task_route, Action::CreateTask);

/// `/api/internal/workflow-actions/*` at its full paths, outside the
/// session pipeline (each route checks the internal bearer itself).
pub fn router<S>(state: WorkflowActionsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    use axum::routing::post;
    Router::new()
        .route(
            "/api/internal/workflow-actions/create-customer",
            post(create_customer_route),
        )
        .route(
            "/api/internal/workflow-actions/create-contact",
            post(create_contact_route),
        )
        .route(
            "/api/internal/workflow-actions/update-contact",
            post(update_contact_route),
        )
        .route(
            "/api/internal/workflow-actions/create-lead",
            post(create_lead_route),
        )
        .route(
            "/api/internal/workflow-actions/create-deal",
            post(create_deal_route),
        )
        .route(
            "/api/internal/workflow-actions/move-deal-stage",
            post(move_deal_stage_route),
        )
        .route(
            "/api/internal/workflow-actions/log-activity",
            post(log_activity_route),
        )
        .route(
            "/api/internal/workflow-actions/post-chat-message",
            post(post_chat_message_route),
        )
        .route(
            "/api/internal/workflow-actions/create-task",
            post(create_task_route),
        )
        .with_state(state)
}
