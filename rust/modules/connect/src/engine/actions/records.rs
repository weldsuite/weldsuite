//! The WeldSuite record steps (`customer.ts`, `crm.ts`, `chat.ts`,
//! `task.ts`): on Global they post to connect-api's
//! `/api/internal/workflow-actions/*`; here the same body goes to
//! [`crate::workflow_actions::perform`] in the process, and a refusal fails
//! the step as `internalApiFailure` reads the route's answer.

use regex::Regex;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_string};
use crate::workflow_actions::{Action, Answer, Performer, perform};

// ── helpers.ts ──────────────────────────────────────────────────────────────

/// `optionalText(value)`: a trimmed string, or `None` when empty.
pub(super) fn optional_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        other => {
            let text = as_text(other);
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
    }
}

/// `EMAIL_ADDRESS`: one `@`, no whitespace or list separators, a dot in
/// the domain.
pub(super) fn is_email_address(text: &str) -> bool {
    static PATTERN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r#"^[^\s@<>(),;:"]+@[^\s@<>(),;:"][^\s@<>(),;:".]*\.[^\s@<>(),;:"]{2,}$"#)
            .expect("the address pattern compiles")
    });
    PATTERN.is_match(text)
}

/// The first `units` UTF-16 units of `text` (`text.slice(0, units)`).
pub(super) fn js_slice(text: &str, units: usize) -> String {
    weldsuite_chat_domain::text::js_prefix(text, units)
}

/// `OUTBOUND_DENIAL_CODES`.
const OUTBOUND_DENIAL_CODES: [&str; 8] = [
    "SENDING_LIMITED",
    "FIRST_CONTACT_LIMITED",
    "SENDING_ON_HOLD",
    "SENDING_SUSPENDED",
    "SENDER_NOT_OWNED",
    "TOO_MANY_RECIPIENTS",
    "RECIPIENT_SUPPRESSED",
    "PLATFORM_LIMITED",
];

/// `readableErrorMessage(body)`.
fn readable_error_message(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let raw = match parsed.get("error") {
        Some(Value::Null) | None => parsed.get("message"),
        some => some,
    };
    let text = match raw {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Object(object)) => match (object.get("message"), object.get("issues")) {
            (Some(Value::String(message)), _) => Some(message.clone()),
            (_, Some(Value::Array(issues))) => Some(
                issues
                    .iter()
                    .map(|issue| {
                        let path = match issue.get("path") {
                            Some(Value::Array(path)) if !path.is_empty() => format!(
                                "{}: ",
                                path.iter()
                                    .map(|p| js_string(Some(p)))
                                    .collect::<Vec<_>>()
                                    .join(".")
                            ),
                            _ => String::new(),
                        };
                        let message = match issue.get("message") {
                            Some(Value::Null) | None => "invalid".to_owned(),
                            Some(message) => js_string(Some(message)),
                        };
                        format!("{path}{message}")
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            ),
            _ => None,
        },
        _ => None,
    }?;
    if text.is_empty() {
        return None;
    }
    static FAILED_FOR: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^\w+ failed for [^:]*:\s*").expect("the prefix pattern compiles")
    });
    static ERROR_CODE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^Error \([A-Z_]+\)\s*").expect("the code pattern compiles")
    });
    let text = FAILED_FOR.replace(&text, "");
    let text = ERROR_CODE.replace(&text, "");
    Some(text.trim().to_owned())
}

/// `internalApiFailure(label, status, body)`: a readable message, the raw
/// answer in `details`, and no retries for a permanent refusal.
pub(super) fn internal_api_failure(label: &str, status: u16, body: &str) -> ActionError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    if let Some(Value::Object(error)) = parsed.as_ref().and_then(|p| p.get("error"))
        && let Some(Value::String(code)) = error.get("code")
        && OUTBOUND_DENIAL_CODES.contains(&code.as_str())
    {
        let message = match error.get("message") {
            Some(Value::String(message)) => message.clone(),
            _ => code.clone(),
        };
        return ActionError::fatal_with(
            &format!("{label} blocked ({code}): {message}"),
            json!({ "status": status, "code": code, "body": js_slice(body, 2000) }),
        );
    }
    let message = match readable_error_message(body) {
        Some(readable) => format!("{label} failed: {readable}"),
        None => format!("{label} failed: {status} - {}", js_slice(body, 500)),
    };
    let details = json!({ "status": status, "body": js_slice(body, 2000) });
    let permanent = status != 408
        && status != 429
        && ((400..500).contains(&status) || body.contains("VALIDATION_ERROR"));
    if permanent {
        ActionError::fatal_with(&message, details)
    } else {
        ActionError {
            details: Some(details),
            ..ActionError::plain(&message)
        }
    }
}

/// The route's body as `JSON.stringify` wrote it: a refusal keeps
/// `success` before `error`.
fn answer_text(answer: &Answer) -> String {
    match (answer.body.get("success"), answer.body.get("error")) {
        (Some(Value::Bool(false)), Some(error @ Value::String(_))) => {
            format!("{{\"success\":false,\"error\":{error}}}")
        }
        (Some(Value::Bool(false)), Some(error)) => {
            format!(
                "{{\"success\":false,\"error\":{}}}",
                crate::js::json_text(error)
            )
        }
        _ => crate::js::json_text(&answer.body),
    }
}

/// `postInternalApi(env, '/workflow-actions/…', body, label, 'CONNECT_INTERNAL')`,
/// in the process.
async fn call(action: Action, body: Value, label: &str, ctx: &ActionCtx<'_>) -> ActionResult {
    let performer = Performer {
        db: ctx.db,
        events: &ctx.deps.events,
        realtime: ctx.deps.realtime.clone(),
        master: ctx.deps.master.as_ref(),
        app_enforce: ctx
            .deps
            .env
            .get("PERMISSIONS_APP_ENFORCE")
            .is_some_and(|v| v == "true"),
    };
    let answer = perform(action, &performer, &body).await;
    if (200..300).contains(&answer.status) {
        Ok(answer.body)
    } else {
        Err(internal_api_failure(
            label,
            answer.status,
            &answer_text(&answer),
        ))
    }
}

/// `workflowActor(ctx)`: who the action acts as.
fn workflow_actor(ctx: &ActionCtx<'_>) -> Result<Map<String, Value>, ActionError> {
    let owner = ctx
        .info
        .owner_user_id
        .as_deref()
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .ok_or_else(|| {
            ActionError::fatal(
                "This workflow has no owner to act as. Save the workflow again and re-run it.",
            )
        })?;
    let mut actor = Map::new();
    actor.insert("workspaceId".into(), json!(ctx.info.workspace_id));
    actor.insert("ownerUserId".into(), json!(owner));
    actor.insert("triggeredBy".into(), json!(ctx.info.user_id));
    actor.insert("chainDepth".into(), json!(ctx.info.chain_depth));
    Ok(actor)
}

/// `{ key: value }` unless `value` is `undefined`.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.into());
    }
}

fn text(inputs: &Map<String, Value>, key: &str) -> Option<String> {
    optional_text(inputs.get(key))
}

/// `textList(value)`: an array or a comma list, trimmed, empty → undefined.
fn text_list(value: Option<&Value>) -> Option<Vec<String>> {
    let items: Vec<String> = match value {
        Some(Value::Array(items)) => items.iter().map(|i| js_string(Some(i))).collect(),
        Some(Value::String(text)) => text.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let list: Vec<String> = items
        .iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    (!list.is_empty()).then_some(list)
}

fn get<'v>(value: &'v Value, path: &[&str]) -> Value {
    let mut at: Option<&'v Value> = Some(value);
    for key in path {
        at = at.and_then(|v| v.get(*key));
    }
    at.cloned().unwrap_or(Value::Null)
}

// ── customer.ts ─────────────────────────────────────────────────────────────

pub(super) async fn create_customer(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let name =
        text(inputs, "name").ok_or_else(|| ActionError::fatal("Customer name is required"))?;
    let email = text(inputs, "email");
    if let Some(email) = &email
        && !is_email_address(email)
    {
        return Err(ActionError::fatal(&format!(
            "Customer email \"{email}\" is not valid"
        )));
    }
    let mut customer = Map::new();
    customer.insert("name".into(), json!(name));
    put(&mut customer, "email", email);
    put(&mut customer, "phone", text(inputs, "phone"));
    put(&mut customer, "website", text(inputs, "website"));
    put(&mut customer, "notes", text(inputs, "notes"));
    let mut body = Map::new();
    body.insert("workspaceId".into(), json!(ctx.info.workspace_id));
    body.insert("userId".into(), json!(ctx.info.user_id));
    put(&mut body, "ownerUserId", ctx.info.owner_user_id.clone());
    body.insert("chainDepth".into(), json!(ctx.info.chain_depth));
    body.insert(
        "skipIfEmailExists".into(),
        json!(inputs.get("skipIfEmailExists") != Some(&Value::Bool(false))),
    );
    body.insert("customer".into(), Value::Object(customer));
    let result = call(
        Action::CreateCustomer,
        Value::Object(body),
        "Create customer",
        ctx,
    )
    .await?;
    Ok(json!({
        "created": get(&result, &["created"]),
        "customerId": get(&result, &["customer", "id"]),
        "name": get(&result, &["customer", "name"]),
        "email": get(&result, &["customer", "email"]),
    }))
}

// ── crm.ts ──────────────────────────────────────────────────────────────────

/// `contactFields(inputs)`.
fn contact_fields(inputs: &Map<String, Value>) -> Result<Map<String, Value>, ActionError> {
    let email = text(inputs, "email");
    if let Some(email) = &email
        && !is_email_address(email)
    {
        return Err(ActionError::fatal(&format!(
            "Contact email \"{email}\" is not valid"
        )));
    }
    let mut fields = Map::new();
    put(&mut fields, "firstName", text(inputs, "firstName"));
    put(&mut fields, "lastName", text(inputs, "lastName"));
    put(&mut fields, "email", email);
    put(&mut fields, "phone", text(inputs, "phone"));
    put(&mut fields, "title", text(inputs, "title"));
    put(&mut fields, "companyId", text(inputs, "companyId"));
    put(&mut fields, "status", text(inputs, "status"));
    put(&mut fields, "notes", text(inputs, "notes"));
    put(&mut fields, "tags", text_list(inputs.get("tags")));
    Ok(fields)
}

/// `contactResult(result)`.
fn contact_result(result: &Value) -> Value {
    let mut out = json!({
        "contactId": get(result, &["contact", "id"]),
        "name": get(result, &["contact", "displayName"]),
        "email": get(result, &["contact", "email"]),
    });
    if let Some(created) = result.get("created") {
        out["created"] = created.clone();
    }
    out
}

pub(super) async fn create_contact(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let fields = contact_fields(inputs)?;
    if !["firstName", "lastName", "email"]
        .iter()
        .any(|k| fields.contains_key(*k))
    {
        return Err(ActionError::fatal(
            "A contact needs a name or an email address",
        ));
    }
    let mut body = workflow_actor(ctx)?;
    body.insert(
        "skipIfEmailExists".into(),
        json!(inputs.get("skipIfEmailExists") != Some(&Value::Bool(false))),
    );
    body.insert("contact".into(), Value::Object(fields));
    let result = call(
        Action::CreateContact,
        Value::Object(body),
        "Create contact",
        ctx,
    )
    .await?;
    Ok(contact_result(&result))
}

pub(super) async fn update_contact(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let contact_id = text(inputs, "contactId")
        .ok_or_else(|| ActionError::fatal("Choose the contact to update"))?;
    let fields = contact_fields(inputs)?;
    if fields.is_empty() {
        return Err(ActionError::fatal("Fill in at least one field to update"));
    }
    let mut body = workflow_actor(ctx)?;
    body.insert("contactId".into(), json!(contact_id));
    body.insert("contact".into(), Value::Object(fields));
    let result = call(
        Action::UpdateContact,
        Value::Object(body),
        "Update contact",
        ctx,
    )
    .await?;
    Ok(contact_result(&result))
}

pub(super) async fn create_lead(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let email =
        text(inputs, "email").ok_or_else(|| ActionError::fatal("A lead needs an email address"))?;
    if !is_email_address(&email) {
        return Err(ActionError::fatal(&format!(
            "Lead email \"{email}\" is not valid"
        )));
    }
    let mut lead = Map::new();
    put(&mut lead, "firstName", text(inputs, "firstName"));
    put(&mut lead, "lastName", text(inputs, "lastName"));
    lead.insert("email".into(), json!(email));
    for key in [
        "companyName",
        "title",
        "phone",
        "mobile",
        "website",
        "source",
        "rating",
        "notes",
    ] {
        put(&mut lead, key, text(inputs, key));
    }
    let mut body = workflow_actor(ctx)?;
    body.insert("lead".into(), Value::Object(lead));
    let result = call(Action::CreateLead, Value::Object(body), "Create lead", ctx).await?;
    Ok(json!({
        "leadId": get(&result, &["lead", "id"]),
        "name": get(&result, &["lead", "name"]),
        "email": get(&result, &["lead", "email"]),
    }))
}

pub(super) async fn create_deal(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let name = text(inputs, "name").ok_or_else(|| ActionError::fatal("A deal needs a name"))?;
    let customer_id = text(inputs, "customerId")
        .ok_or_else(|| ActionError::fatal("Choose the company this deal belongs to"))?;
    let mut deal = Map::new();
    deal.insert("name".into(), json!(name));
    deal.insert("customerId".into(), json!(customer_id));
    put(&mut deal, "description", text(inputs, "description"));
    match inputs.get("amount") {
        None => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(amount) => {
            deal.insert("amount".into(), amount.clone());
        }
    }
    for key in ["currency", "pipeline", "stageId", "closeDate"] {
        put(&mut deal, key, text(inputs, key));
    }
    let mut body = workflow_actor(ctx)?;
    body.insert("deal".into(), Value::Object(deal));
    let result = call(Action::CreateDeal, Value::Object(body), "Create deal", ctx).await?;
    Ok(json!({
        "dealId": get(&result, &["deal", "id"]),
        "name": get(&result, &["deal", "name"]),
        "stage": get(&result, &["deal", "stage"]),
        "status": get(&result, &["deal", "status"]),
    }))
}

pub(super) async fn move_deal_stage(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let deal_id =
        text(inputs, "dealId").ok_or_else(|| ActionError::fatal("Choose the deal to move"))?;
    let stage_id = text(inputs, "stageId")
        .ok_or_else(|| ActionError::fatal("Choose the pipeline stage to move the deal to"))?;
    let mut body = workflow_actor(ctx)?;
    body.insert("dealId".into(), json!(deal_id));
    body.insert("stageId".into(), json!(stage_id));
    let result = call(
        Action::MoveDealStage,
        Value::Object(body),
        "Move deal stage",
        ctx,
    )
    .await?;
    Ok(json!({
        "dealId": get(&result, &["deal", "id"]),
        "stageId": get(&result, &["deal", "stageId"]),
        "status": get(&result, &["deal", "status"]),
    }))
}

pub(super) async fn log_activity(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let subject =
        text(inputs, "subject").ok_or_else(|| ActionError::fatal("An activity needs a subject"))?;
    let mut activity = Map::new();
    activity.insert(
        "type".into(),
        json!(text(inputs, "type").unwrap_or_else(|| "note".to_owned())),
    );
    activity.insert("subject".into(), json!(subject));
    for key in [
        "description",
        "dueDate",
        "customerId",
        "contactId",
        "personId",
        "opportunityId",
    ] {
        put(&mut activity, key, text(inputs, key));
    }
    let mut body = workflow_actor(ctx)?;
    body.insert("activity".into(), Value::Object(activity));
    let result = call(
        Action::LogActivity,
        Value::Object(body),
        "Log activity",
        ctx,
    )
    .await?;
    Ok(json!({
        "activityId": get(&result, &["activity", "id"]),
        "type": get(&result, &["activity", "type"]),
        "subject": get(&result, &["activity", "subject"]),
    }))
}

// ── chat.ts ─────────────────────────────────────────────────────────────────

pub(super) async fn post_chat_message(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let channel_id = text(inputs, "channelId")
        .ok_or_else(|| ActionError::fatal("Choose a channel to post to"))?;
    let message = match inputs.get("message") {
        None | Some(Value::Null) => inputs.get("content"),
        some => some,
    };
    let content =
        optional_text(message).ok_or_else(|| ActionError::fatal("Write a message to post"))?;
    let workflow_id = ctx.trigger_data.get("workflowId").and_then(Value::as_str);
    let workflow_name = ctx
        .trigger_data
        .get("workflowName")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty());
    let mut body = workflow_actor(ctx)?;
    body.insert("channelId".into(), json!(channel_id));
    body.insert("content".into(), json!(content));
    put(&mut body, "mentions", text_list(inputs.get("mentions")));
    put(&mut body, "workflowId", workflow_id);
    put(&mut body, "workflowName", workflow_name);
    let result = call(
        Action::PostChatMessage,
        Value::Object(body),
        "Post chat message",
        ctx,
    )
    .await?;
    Ok(json!({
        "messageId": get(&result, &["message", "id"]),
        "channelId": get(&result, &["message", "channelId"]),
    }))
}

// ── task.ts ─────────────────────────────────────────────────────────────────

/// `resolveDueDate(value)`: `today`, `tomorrow` and `in 3 days` as ISO
/// times from now; anything else as it is.
fn resolve_due_date(value: Option<&Value>) -> Option<String> {
    static RELATIVE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)^in\s+(\d+)\s*(hours?|h|days?|d|weeks?|w)$")
            .expect("the due date pattern compiles")
    });
    let text = optional_text(value)?;
    let now = OffsetDateTime::now_utc();
    let iso = |at: OffsetDateTime| weldsuite_events::iso_timestamp(at);
    match text.to_lowercase().as_str() {
        "today" => return Some(iso(now)),
        "tomorrow" => return Some(iso(now + time::Duration::days(1))),
        _ => {}
    }
    let Some(captures) = RELATIVE.captures(&text) else {
        return Some(text);
    };
    let amount: i64 = captures[1].parse().unwrap_or(0);
    let unit_ms: i64 = match captures[2].chars().next().map(|c| c.to_ascii_lowercase()) {
        Some('h') => 3_600_000,
        Some('w') => 604_800_000,
        _ => 86_400_000,
    };
    Some(iso(now
        + time::Duration::milliseconds(
            amount.saturating_mul(unit_ms),
        )))
}

pub(super) async fn create_task(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let project_id = text(inputs, "projectId")
        .ok_or_else(|| ActionError::fatal("Choose the project to create the task in"))?;
    let title = text(inputs, "title").ok_or_else(|| ActionError::fatal("A task needs a title"))?;
    let mut task = Map::new();
    task.insert("title".into(), json!(title));
    for key in ["description", "priority", "stageId"] {
        put(&mut task, key, text(inputs, key));
    }
    let assignees = match inputs.get("assigneeIds") {
        None | Some(Value::Null) => inputs.get("assigneeId"),
        some => some,
    };
    put(&mut task, "assigneeIds", text_list(assignees));
    put(
        &mut task,
        "dueDate",
        resolve_due_date(inputs.get("dueDate")),
    );
    put(&mut task, "labels", text_list(inputs.get("labels")));
    put(&mut task, "tags", text_list(inputs.get("tags")));
    let mut body = workflow_actor(ctx)?;
    body.insert("projectId".into(), json!(project_id));
    body.insert("task".into(), Value::Object(task));
    let result = call(Action::CreateTask, Value::Object(body), "Create task", ctx).await?;
    let task = result.get("task").cloned().unwrap_or(Value::Null);
    let id = get(&task, &["id"]);
    let number = get(&task, &["number"]);
    let project = get(&task, &["projectId"]);
    let url = match &project {
        Value::String(p) if !p.is_empty() => {
            json!(format!("/weldflow/task/{}", js_string(Some(&id))))
        }
        _ => Value::Null,
    };
    Ok(json!({
        "taskId": id,
        "number": number,
        "key": if number.is_null() { Value::Null } else { json!(js_string(Some(&number))) },
        "projectId": project,
        "title": get(&task, &["title"]),
        "url": url,
    }))
}
