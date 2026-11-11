//! The service catalogue: `routes/desk-catalog/index.ts` at
//! `/api/desk/catalog`. Request items, each with its own form (a customer
//! ticket type), approval steps and fulfilment tasks, and the approvals
//! waiting for a decision. The rules and writes are
//! [`weldsuite_desk_domain::catalog`]; the request side (making a
//! conversation a request, deciding its approvals) is on the conversation
//! ([`super::request`]).
//!
//! Every mutation publishes a `desk_catalog_item` entity event. Answers: 400
//! `details.field` for an item that can't be saved, 404 for an unknown item.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::attributes::PRIORITIES;
use weldsuite_desk_domain::catalog::{
    self, APPROVER_TYPES, CatalogError, ItemInput, MAX_APPROVAL_STEPS, MAX_FULFILMENT_TASKS,
    StepInput, TaskInput,
};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::Ctx;
use super::inbox::read_query;
use crate::{DeskState, Refusal, validate};

/// `DEFAULT_APPROVALS_LIMIT`.
const DEFAULT_APPROVALS_LIMIT: f64 = 100.0;

/// `/desk/catalog`. `/approvals` is a path of its own, never an item's id.
pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let manage = || gate.require([perm::SETTINGS_UPDATE.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(manage()))
        .route("/approvals", get(approvals).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update).route_layer(manage()))
        .route("/{id}", delete(remove).route_layer(manage()))
}

/// `refusal(c, err, failure)`: an item that can't be saved is a 400 naming
/// the field; anything else the route's 500.
fn refused(error: CatalogError, failure: &str) -> Response {
    match error {
        CatalogError::Rejected { field, message } => ApiError::bad_request(message)
            .with_details(json!({ "field": field }))
            .into_response(),
        error => {
            tracing::error!(%error, "[desk-api/desk-catalog] {failure}");
            ApiError::internal().with_message(failure).into_response()
        }
    }
}

fn not_found(id: &str) -> Response {
    ApiError::not_found("Catalogue item", Some(id)).into_response()
}

// ── GET / ─────────────────────────────────────────────────────────────────────

/// `deskCatalogListQuerySchema`: `all=1` includes switched-off items.
fn list_schema(issues: &mut Issues, values: &Map<String, Value>) -> bool {
    issues
        .choice(values, "all", Presence::Optional, &["1", "true"])
        .into_option()
        .is_some()
}

async fn list(ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let all = match read_query(query.as_deref(), list_schema) {
        Ok(all) => all,
        Err(response) => return response,
    };
    let caller = &ctx.caller;
    if all && !caller.can(perm::SETTINGS_READ) {
        return ApiError::forbidden()
            .with_message("Reading the whole catalogue needs settings access")
            .into_response();
    }
    match catalog::list_items(&caller.db, !all).await {
        Ok(items) => Data(items).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to load the service catalogue"),
    }
}

// ── GET /approvals ────────────────────────────────────────────────────────────

/// `deskCatalogApprovalsQuerySchema`: whose steps, and how many.
fn approvals_schema(
    issues: &mut Issues,
    values: &Map<String, Value>,
) -> (Option<String>, Option<f64>) {
    let scope = issues
        .choice(values, "scope", Presence::Optional, &["mine", "all"])
        .into_option();
    let limit = issues
        .number(
            values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(200.0),
            },
        )
        .into_option();
    (scope, limit)
}

/// The steps waiting for a decision: the caller's own (`scope=mine`, the
/// default), or everyone's for someone who manages the catalogue.
async fn approvals(ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let (scope, limit) = match read_query(query.as_deref(), approvals_schema) {
        Ok(read) => read,
        Err(response) => return response,
    };
    let caller = &ctx.caller;
    let everyone = scope.as_deref() == Some("all");
    if everyone && !caller.can(perm::SETTINGS_UPDATE) {
        return ApiError::forbidden()
            .with_message("Seeing every approval needs settings access")
            .into_response();
    }
    #[allow(clippy::cast_possible_truncation)] // an integer from 1 to 200
    let limit = limit.unwrap_or(DEFAULT_APPROVALS_LIMIT) as i64;
    let approver = (!everyone).then_some(caller.user_id.as_str());
    match catalog::pending_approvals(&caller.db, approver, limit).await {
        Ok(pending) => Data(pending).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to load the approvals"),
    }
}

// ── GET /:id ──────────────────────────────────────────────────────────────────

async fn detail(ctx: Ctx, Path(id): Path<String>) -> Response {
    match catalog::get_item(&ctx.caller.db, &id).await {
        Ok(Some(item)) => Data(item).into_response(),
        Ok(None) => not_found(&id),
        Err(error) => Refusal::Database(error).respond("Failed to load the catalogue item"),
    }
}

// ── POST / and PATCH /:id ─────────────────────────────────────────────────────

/// `shortId`: `z.string().min(1).max(30)`.
const SHORT_ID: Text = Text::length(Some(1), Some(30));

/// `z.string().trim().max(max).nullish()`.
fn trimmed(issues: &mut Issues, body: &Map<String, Value>, key: &str, max: usize) -> Field<String> {
    issues.text_with(body, key, Presence::Nullish, Text::trimmed(None, Some(max)))
}

/// `deskCatalogApprovalStepInputSchema`.
fn step_schema(issues: &mut Issues, step: &Map<String, Value>) -> StepInput {
    let id = issues
        .text(step, "id", Presence::Optional, Some(1), Some(64))
        .into_option();
    let name = trimmed(issues, step, "name", 255);
    let approver_type = issues
        .choice(step, "approverType", Presence::Required, APPROVER_TYPES)
        .into_option()
        .unwrap_or_default();
    let approver_id = issues.text(step, "approverId", Presence::Nullish, Some(1), Some(255));
    let department_id = issues.text_with(step, "departmentId", Presence::Nullish, SHORT_ID);
    StepInput {
        id,
        name,
        approver_type,
        approver_id,
        department_id,
    }
}

/// `deskCatalogFulfilmentTaskInputSchema`.
fn task_schema(issues: &mut Issues, task: &Map<String, Value>) -> TaskInput {
    let id = issues
        .text(task, "id", Presence::Optional, Some(1), Some(64))
        .into_option();
    let title = issues
        .text_with(
            task,
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option()
        .unwrap_or_default();
    let description = trimmed(issues, task, "description", 5000);
    let assignee_id = issues.text(task, "assigneeId", Presence::Nullish, Some(1), Some(255));
    let due_in_days = issues.whole_number(
        task,
        "dueInDays",
        Presence::Nullish,
        Number {
            min: Some(0.0),
            max: Some(365.0),
            ..Number::default()
        },
    );
    TaskInput {
        id,
        title,
        description,
        assignee_id,
        due_in_days,
    }
}

/// `createDeskCatalogItemSchema` (`create`: a name and a form are required)
/// and `updateDeskCatalogItemSchema` (only the keys present change).
fn item_schema(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> ItemInput {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let name = issues
        .text_with(body, "name", required, Text::trimmed(Some(1), Some(255)))
        .into_option();
    let summary = trimmed(issues, body, "summary", 500);
    let description = trimmed(issues, body, "description", 10_000);
    let category = trimmed(issues, body, "category", 100);
    let icon = trimmed(issues, body, "icon", 50);
    let ticket_type_id = issues
        .text_with(body, "ticketTypeId", required, SHORT_ID)
        .into_option();
    let department_id = issues.text_with(body, "departmentId", Presence::Nullish, SHORT_ID);
    let priority = issues.choice(body, "priority", Presence::Nullish, PRIORITIES);
    let delivery_estimate = trimmed(issues, body, "deliveryEstimate", 100);
    let approval_steps = issues
        .list(
            body,
            "approvalSteps",
            Presence::Optional,
            None,
            Some(MAX_APPROVAL_STEPS),
            |issues, item| issues.object(item).map(|step| step_schema(issues, step)),
        )
        .into_option();
    let fulfilment_tasks = issues
        .list(
            body,
            "fulfilmentTasks",
            Presence::Optional,
            None,
            Some(MAX_FULFILMENT_TASKS),
            |issues, item| issues.object(item).map(|task| task_schema(issues, task)),
        )
        .into_option();
    let audience_company_ids = issues
        .list(
            body,
            "audienceCompanyIds",
            Presence::Optional,
            None,
            Some(200),
            |issues, item| issues.item_text(item, SHORT_ID),
        )
        .into_option();
    let is_active = issues
        .boolean(body, "isActive", Presence::Optional)
        .into_option();
    let sort_order = issues
        .whole_number(
            body,
            "sortOrder",
            Presence::Optional,
            Number {
                min: Some(0.0),
                max: Some(100_000.0),
                ..Number::default()
            },
        )
        .into_option();
    ItemInput {
        name,
        summary,
        description,
        category,
        icon,
        ticket_type_id,
        department_id,
        priority,
        delivery_estimate,
        approval_steps,
        fulfilment_tasks,
        audience_company_ids,
        is_active,
        sort_order,
    }
}

fn item_id(item: &Value) -> &str {
    item["id"].as_str().unwrap_or_default()
}

async fn create(
    State(state): State<DeskState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to create the catalogue item";
    let input = match validate(&headers, &body, |issues, body| {
        item_schema(issues, body, true)
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    match catalog::create_item(&caller.db, &input, Some(&caller.user_id)).await {
        Ok(item) => {
            caller.publish(&state, ev::DESK_CATALOG_ITEM_CREATED, item_id(&item), &item);
            Created(item).into_response()
        }
        Err(error) => refused(error, failure),
    }
}

async fn update(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to update the catalogue item";
    let patch = match validate(&headers, &body, |issues, body| {
        item_schema(issues, body, false)
    }) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    match catalog::update_item(&caller.db, &id, &patch).await {
        Ok(Some(item)) => {
            caller.publish(&state, ev::DESK_CATALOG_ITEM_UPDATED, item_id(&item), &item);
            Data(item).into_response()
        }
        Ok(None) => not_found(&id),
        Err(error) => refused(error, failure),
    }
}

// ── DELETE /:id ───────────────────────────────────────────────────────────────

async fn remove(State(state): State<DeskState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let caller = &ctx.caller;
    match catalog::delete_item(&caller.db, &id).await {
        Ok(Some(item)) => {
            caller.publish(&state, ev::DESK_CATALOG_ITEM_DELETED, item_id(&item), &item);
            NoContent.into_response()
        }
        Ok(None) => not_found(&id),
        Err(error) => Refusal::Database(error).respond("Failed to delete the catalogue item"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_kit::validation::query_values;

    fn body_issues<T>(
        body: &Value,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Value {
        let mut issues = Issues::default();
        let _ = read(&mut issues, body.as_object().expect("object"));
        issues
            .finish()
            .map_or_else(|invalid| json!(invalid.issues()), |()| json!([]))
    }

    fn query_issues<T>(
        query: &str,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Value {
        let values = query_values(Some(query));
        let mut issues = Issues::default();
        let _ = read(&mut issues, &values);
        issues
            .finish()
            .map_or_else(|invalid| json!(invalid.issues()), |()| json!([]))
    }

    fn new_item(issues: &mut Issues, body: &Map<String, Value>) -> ItemInput {
        item_schema(issues, body, true)
    }

    fn patch(issues: &mut Issues, body: &Map<String, Value>) -> ItemInput {
        item_schema(issues, body, false)
    }

    /// Zod 3's own output for `createDeskCatalogItemSchema`, in the schema's
    /// order: every field, then every step and task field by field.
    #[test]
    fn a_new_item_is_checked_field_by_field() {
        let body = json!({
            "name": "   ",
            "summary": 5,
            "ticketTypeId": "",
            "priority": "huge",
            "approvalSteps": [
                { "approverType": "boss", "id": "" },
                "x",
                { "approverType": "member", "approverId": "", "departmentId": 7, "name": null },
            ],
            "fulfilmentTasks": [
                { "title": " ", "dueInDays": 1.5 },
                { "title": "ok", "dueInDays": 400, "assigneeId": "" },
                { "id": null },
            ],
            "audienceCompanyIds": ["", 3, "ok"],
            "isActive": "yes",
            "sortOrder": -1,
        });
        assert_eq!(
            body_issues(&body, new_item),
            json!([
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["name"]},
                {"code":"invalid_type","expected":"string","received":"number","path":["summary"],"message":"Expected string, received number"},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["ticketTypeId"]},
                {"received":"huge","code":"invalid_enum_value","options":["low","medium","high","urgent"],"path":["priority"],"message":"Invalid enum value. Expected 'low' | 'medium' | 'high' | 'urgent', received 'huge'"},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["approvalSteps",0,"id"]},
                {"received":"boss","code":"invalid_enum_value","options":["member","team_manager"],"path":["approvalSteps",0,"approverType"],"message":"Invalid enum value. Expected 'member' | 'team_manager', received 'boss'"},
                {"code":"invalid_type","expected":"object","received":"string","path":["approvalSteps",1],"message":"Expected object, received string"},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["approvalSteps",2,"approverId"]},
                {"code":"invalid_type","expected":"string","received":"number","path":["approvalSteps",2,"departmentId"],"message":"Expected string, received number"},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["fulfilmentTasks",0,"title"]},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["fulfilmentTasks",0,"dueInDays"]},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["fulfilmentTasks",1,"assigneeId"]},
                {"code":"too_big","maximum":365,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 365","path":["fulfilmentTasks",1,"dueInDays"]},
                {"code":"invalid_type","expected":"string","received":"null","path":["fulfilmentTasks",2,"id"],"message":"Expected string, received null"},
                {"code":"invalid_type","expected":"string","received":"undefined","path":["fulfilmentTasks",2,"title"],"message":"Required"},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["audienceCompanyIds",0]},
                {"code":"invalid_type","expected":"string","received":"number","path":["audienceCompanyIds",1],"message":"Expected string, received number"},
                {"code":"invalid_type","expected":"boolean","received":"string","path":["isActive"],"message":"Expected boolean, received string"},
                {"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["sortOrder"]},
            ])
        );
        assert_eq!(
            body_issues(&json!({}), new_item),
            json!([
                {"code":"invalid_type","expected":"string","received":"undefined","path":["name"],"message":"Required"},
                {"code":"invalid_type","expected":"string","received":"undefined","path":["ticketTypeId"],"message":"Required"},
            ])
        );
    }

    /// Zod 3's own output: at most five steps and twenty tasks, and a list
    /// that is left out is not null.
    #[test]
    fn steps_and_tasks_are_capped() {
        let steps: Vec<Value> = (0..6)
            .map(|_| json!({ "approverType": "team_manager" }))
            .collect();
        assert_eq!(
            body_issues(
                &json!({ "name": "x", "ticketTypeId": "t", "approvalSteps": steps }),
                new_item
            ),
            json!([{"code":"too_big","maximum":5,"type":"array","inclusive":true,"exact":false,"message":"Array must contain at most 5 element(s)","path":["approvalSteps"]}])
        );
        let tasks: Vec<Value> = (0..21)
            .map(|i| json!({ "title": format!("Task {i}") }))
            .collect();
        assert_eq!(
            body_issues(
                &json!({
                    "name": "x", "ticketTypeId": "t", "fulfilmentTasks": tasks,
                    "approvalSteps": null,
                }),
                new_item
            ),
            json!([
                {"code":"invalid_type","expected":"array","received":"null","path":["approvalSteps"],"message":"Expected array, received null"},
                {"code":"too_big","maximum":20,"type":"array","inclusive":true,"exact":false,"message":"Array must contain at most 20 element(s)","path":["fulfilmentTasks"]},
            ])
        );
    }

    /// Zod 3's own output for `updateDeskCatalogItemSchema`: every key may be
    /// left out, the name and the form may not be null.
    #[test]
    fn a_patch_may_leave_out_every_key() {
        assert_eq!(body_issues(&json!({}), patch), json!([]));
        assert_eq!(
            body_issues(
                &json!({
                    "name": null, "ticketTypeId": null, "category": null, "isActive": null,
                    "sortOrder": 2.5, "approvalSteps": "x",
                }),
                patch
            ),
            json!([
                {"code":"invalid_type","expected":"string","received":"null","path":["name"],"message":"Expected string, received null"},
                {"code":"invalid_type","expected":"string","received":"null","path":["ticketTypeId"],"message":"Expected string, received null"},
                {"code":"invalid_type","expected":"array","received":"string","path":["approvalSteps"],"message":"Expected array, received string"},
                {"code":"invalid_type","expected":"boolean","received":"null","path":["isActive"],"message":"Expected boolean, received null"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["sortOrder"]},
            ])
        );
    }

    #[test]
    fn an_item_is_read_trimmed_with_what_it_leaves_out() {
        let mut issues = Issues::default();
        let body = json!({
            "name": "  New laptop ", "ticketTypeId": "ttyp_hw", "summary": "  A work laptop ",
            "category": null,
            "approvalSteps": [
                { "approverType": "member", "approverId": "user_alice", "name": " Budget " },
            ],
            "fulfilmentTasks": [{ "title": " Order it ", "dueInDays": 3 }, { "title": "Image it" }],
            "sortOrder": 4,
        });
        let item = new_item(&mut issues, body.as_object().expect("object"));
        assert!(issues.finish().is_ok());
        assert_eq!(item.name.as_deref(), Some("New laptop"));
        assert_eq!(item.summary, Field::Set("A work laptop".to_owned()));
        assert_eq!(item.category, Field::Null);
        assert_eq!(item.icon, Field::Absent);
        assert_eq!(item.is_active, None);
        assert_eq!(item.sort_order, Some(4));
        let steps = item.approval_steps.expect("steps");
        assert_eq!(steps[0].name, Field::Set("Budget".to_owned()));
        assert_eq!(steps[0].id, None);
        let tasks = item.fulfilment_tasks.expect("tasks");
        assert_eq!(tasks[0].title, "Order it");
        assert_eq!(tasks[0].due_in_days, Field::Set(3));
        assert_eq!(tasks[1].due_in_days, Field::Absent);
        assert_eq!(item.audience_company_ids, None);
    }

    /// Zod 3's own output for the two query schemas.
    #[test]
    fn the_queries_are_checked() {
        assert_eq!(
            query_issues("scope=nobody&limit=0", approvals_schema),
            json!([
                {"received":"nobody","code":"invalid_enum_value","options":["mine","all"],"path":["scope"],"message":"Invalid enum value. Expected 'mine' | 'all', received 'nobody'"},
                {"code":"too_small","minimum":1,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 1","path":["limit"]},
            ])
        );
        assert_eq!(
            query_issues("limit=abc", approvals_schema),
            json!([{"code":"invalid_type","expected":"number","received":"nan","path":["limit"],"message":"Expected number, received nan"}])
        );
        assert_eq!(
            query_issues("limit=201&scope=mine&scope=all", approvals_schema),
            json!([
                {"expected":"'mine' | 'all'","received":"array","code":"invalid_type","path":["scope"],"message":"Expected 'mine' | 'all', received array"},
                {"code":"too_big","maximum":200,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 200","path":["limit"]},
            ])
        );
        assert_eq!(
            query_issues("all=yes", list_schema),
            json!([{"received":"yes","code":"invalid_enum_value","options":["1","true"],"path":["all"],"message":"Invalid enum value. Expected '1' | 'true', received 'yes'"}])
        );
        let read = |query: &str| {
            let mut issues = Issues::default();
            list_schema(&mut issues, &query_values(Some(query)))
        };
        assert!(read("all=1"));
        assert!(read("all=true"));
        assert!(!read(""));
    }
}
