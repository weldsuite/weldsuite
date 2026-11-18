//! `/api/panel/group-types` (`routes/group-types/index.ts`,
//! `services/groups.ts`): the kinds of group a project's events can belong
//! to (`company`, `workspace`), with their display names and the profile
//! property matched against WeldCRM companies.
//!
//!   GET    /       → ?projectId: the configured types, then the types the project
//!                    collects without a row (`id: null`, `configured: false`)
//!   POST   /       → configure a type: takes one of the project's five slots
//!   PATCH  /:id    → names and the CRM match property
//!   DELETE /:id    → removes the row and frees the slot (the profiles stay)
//!
//! The project state ([`PanelProjectState`]) hands out the slots. A sixth
//! row, or a type it has no slot for, is a 409 `GROUP_TYPE_LIMIT`. Without
//! the project state the list still answers (nothing is collecting) and
//! creating answers 503.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_GROUP_TYPE_CREATED, PANEL_GROUP_TYPE_DELETED, PANEL_GROUP_TYPE_UPDATED,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};

use crate::project_state::{PanelProjectState, ProjectRef};
use crate::projects::live_project;
use crate::query::QueryFailure;
use crate::saved::{field, rows, text};
use crate::schemas_gen::{
    CREATE_PANEL_GROUP_TYPE, PANEL_GROUP_TYPE_LIST_QUERY, UPDATE_PANEL_GROUP_TYPE,
};
use crate::{Caller, PanelState, unexpected};

/// Group types one project collects (`MAX_GROUP_TYPES` in `wire.ts`).
const MAX_GROUP_TYPES: usize = 5;

/// `defaultGroupTypeNames(groupType)`: `company` → Company / Companies.
fn default_names(group_type: &str) -> (String, String) {
    let words = group_type.replace('_', " ");
    let words = weldsuite_panel_domain::js::trim(&words);
    let mut chars = words.chars();
    let singular: String = chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default();
    let vowel = |c: char| matches!(c, 'a' | 'e' | 'i' | 'o' | 'u');
    let mut tail = singular.chars().rev();
    let (last, before) = (tail.next(), tail.next());
    let plural = if last == Some('y') && before.is_some_and(|c| !vowel(c)) {
        format!("{}ies", &singular[..singular.len() - 1])
    } else if ["s", "x", "z", "ch", "sh"]
        .iter()
        .any(|end| singular.ends_with(end))
    {
        format!("{singular}es")
    } else {
        format!("{singular}s")
    };
    (singular, plural)
}

/// `toGroupTypeDto(row, collecting)`.
fn dto(row: &Value, collecting: bool) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "groupType": field(row, "groupType"),
        "nameSingular": field(row, "nameSingular"),
        "namePlural": field(row, "namePlural"),
        "crmMatchProperty": field(row, "crmMatchProperty"),
        "configured": true,
        "collecting": collecting,
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `unconfiguredGroupTypeDto(projectId, groupType)`.
fn unconfigured_dto(project_id: &str, group_type: &str) -> Value {
    let (singular, plural) = default_names(group_type);
    json!({
        "id": null,
        "projectId": project_id,
        "groupType": group_type,
        "nameSingular": singular,
        "namePlural": plural,
        "crmMatchProperty": null,
        "configured": false,
        "collecting": true,
        "createdAt": null,
        "updatedAt": null,
    })
}

/// `groupTypeEventData(row)`.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "groupType": field(row, "groupType"),
        "nameSingular": field(row, "nameSingular"),
        "namePlural": field(row, "namePlural"),
    })
}

fn publish(caller: &Caller, state: &PanelState, row: &Value, event: EventName) {
    caller.publish(state, event, text(row, "id"), &event_data(row));
}

/// The 409 for a project without a free slot.
fn limit_reached(types: &[String]) -> Response {
    ApiError::new(
        StatusCode::CONFLICT,
        "GROUP_TYPE_LIMIT",
        format!(
            "A project collects at most {MAX_GROUP_TYPES} group types. Delete one to make room."
        ),
    )
    .with_details(json!({ "max": MAX_GROUP_TYPES, "types": types }))
    .into_response()
}

async fn list_rows(caller: &Caller, project_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from panel_group_types t
         where t.project_id = $1 order by t.created_at asc, t.id asc",
    )
    .bind(project_id)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows(found))
}

async fn get_row(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from panel_group_types t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

fn project_ref<'a>(caller: &'a Caller, project_id: &'a str) -> ProjectRef<'a> {
    ProjectRef {
        workspace_id: &caller.workspace_id,
        project_id,
    }
}

/// `collectedGroupTypes(env, projectId)`: `None` without the project state.
async fn collected(
    caller: &Caller,
    project_state: Option<&Arc<dyn PanelProjectState>>,
    project_id: &str,
) -> Result<Option<Vec<String>>, QueryFailure> {
    let Some(project_state) = project_state else {
        return Ok(None);
    };
    project_state
        .group_types(project_ref(caller, project_id))
        .await
        .map(Some)
        .map_err(QueryFailure::upstream)
}

/// `isCollecting(c, row)`: false (with a warning) when it cannot be asked.
async fn is_collecting(caller: &Caller, state: &PanelState, row: &Value) -> bool {
    let project_state = caller.project_state(state);
    match collected(caller, project_state.as_ref(), text(row, "projectId")).await {
        Ok(types) => types
            .unwrap_or_default()
            .iter()
            .any(|t| t == text(row, "groupType")),
        Err(error) => {
            tracing::warn!(
                ?error,
                "[panel-api] could not read the collected group types"
            );
            false
        }
    }
}

/// `GET /?projectId=`.
pub(crate) async fn list(
    State(state): State<PanelState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&PANEL_GROUP_TYPE_LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let project_id = query.text("projectId").unwrap_or_default().to_owned();
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "list group types"),
    }
    let rows = match list_rows(&caller, &project_id).await {
        Ok(rows) => rows,
        Err(error) => return unexpected(&error, "list group types"),
    };
    let project_state = caller.project_state(&state);
    let collected = match collected(&caller, project_state.as_ref(), &project_id).await {
        Ok(collected) => collected,
        Err(failure) => return failure.into_response(),
    };
    // `mergeGroupTypes`: the rows, then the collected types without one.
    let taken = collected.clone().unwrap_or_default();
    let mut types: Vec<Value> = rows
        .iter()
        .map(|row| dto(row, taken.iter().any(|t| t == text(row, "groupType"))))
        .collect();
    for group_type in &taken {
        if !rows.iter().any(|row| text(row, "groupType") == group_type) {
            types.push(unconfigured_dto(&project_id, group_type));
        }
    }
    let count = types.len() as u64;
    List::new(types, Pagination::new(count, false, None)).into_response()
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_GROUP_TYPE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    let group_type = input.text("groupType").unwrap_or_default().to_owned();
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create group type"),
    }
    let duplicate = || {
        ApiError::conflict(format!(
            "The group type '{group_type}' is already configured"
        ))
        .into_response()
    };
    let existing = match list_rows(&caller, &project_id).await {
        Ok(existing) => existing,
        Err(error) => return unexpected(&error, "create group type"),
    };
    if existing
        .iter()
        .any(|row| text(row, "groupType") == group_type)
    {
        return duplicate();
    }
    if existing.len() >= MAX_GROUP_TYPES {
        let types: Vec<String> = existing
            .iter()
            .map(|row| text(row, "groupType").to_owned())
            .collect();
        return limit_reached(&types);
    }
    let Some(project_state) = caller.project_state(&state) else {
        return ApiError::unavailable("Groups are not configured here").into_response();
    };
    let wanted = [group_type.clone()];
    let types = match project_state
        .ensure_group_types(project_ref(&caller, &project_id), &wanted)
        .await
    {
        Ok(types) => types,
        Err(error) => return QueryFailure::upstream(error).into_response(),
    };
    if !types.contains(&group_type) {
        return limit_reached(&types);
    }
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into panel_group_types as t
           (id, project_id, group_type, name_singular, name_plural, crm_match_property)
         values ($1, $2, $3, $4, $5, $6)
         returning to_jsonb(t)",
    )
    .bind(weldsuite_kit::id::generate_id("pngt"))
    .bind(&project_id)
    .bind(&group_type)
    .bind(input.text("nameSingular"))
    .bind(input.text("namePlural"))
    .bind(input.get("crmMatchProperty").and_then(Value::as_str))
    .fetch_one(&caller.db)
    .await;
    let row = match inserted {
        Ok(row) => weldsuite_db::js_row(row),
        // Created by a concurrent request between the check and the insert.
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => return duplicate(),
        Err(error) => return unexpected(&error, "create group type"),
    };
    publish(&caller, &state, &row, PANEL_GROUP_TYPE_CREATED);
    Created(dto(&row, true)).into_response()
}

/// The row when it and its project exist, or the 404.
async fn existing(caller: &Caller, id: &str) -> Result<Value, Box<Response>> {
    let row = match get_row(caller, id).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Err(Box::new(
                ApiError::not_found("Group type", Some(id)).into_response(),
            ));
        }
        Err(error) => return Err(Box::new(unexpected(&error, "get group type"))),
    };
    match live_project(caller, text(&row, "projectId")).await {
        Ok(Some(_)) => Ok(row),
        Ok(None) => Err(Box::new(
            ApiError::not_found("Group type", Some(id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get group type"))),
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_GROUP_TYPE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if let Err(response) = existing(&caller, &id).await {
        return *response;
    }
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_group_types as t set
           name_singular = coalesce($2, t.name_singular),
           name_plural = coalesce($3, t.name_plural),
           crm_match_property = case when $4 then $5 else t.crm_match_property end,
           updated_at = now()
         where t.id = $1
         returning to_jsonb(t)",
    )
    .bind(&id)
    .bind(input.get("nameSingular").and_then(Value::as_str))
    .bind(input.get("namePlural").and_then(Value::as_str))
    .bind(input.get("crmMatchProperty").is_some())
    .bind(input.get("crmMatchProperty").and_then(Value::as_str))
    .fetch_optional(&caller.db)
    .await;
    let row = match updated {
        Ok(Some(row)) => weldsuite_db::js_row(row),
        Ok(None) => return ApiError::not_found("Group type", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "update group type"),
    };
    publish(&caller, &state, &row, PANEL_GROUP_TYPE_UPDATED);
    let collecting = is_collecting(&caller, &state, &row).await;
    Data(dto(&row, collecting)).into_response()
}

/// `DELETE /:id`: the row, then the slot (best effort: a missing or failing
/// project state leaves the type collected).
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = existing(&caller, &id).await {
        return *response;
    }
    let deleted: Result<Option<Value>, sqlx::Error> =
        sqlx::query_scalar("delete from panel_group_types t where t.id = $1 returning to_jsonb(t)")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await;
    let row = match deleted {
        Ok(Some(row)) => weldsuite_db::js_row(row),
        Ok(None) => return ApiError::not_found("Group type", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete group type"),
    };
    if let Some(project_state) = caller.project_state(&state) {
        if let Err(error) = project_state
            .release_group_type(
                project_ref(&caller, text(&row, "projectId")),
                text(&row, "groupType"),
            )
            .await
        {
            tracing::warn!(%error, "[panel-api] could not free a deleted group type's slot");
        }
    } else {
        tracing::warn!(
            "[panel-api] no project state; the slot of a deleted group type stays taken"
        );
    }
    publish(&caller, &state, &row, PANEL_GROUP_TYPE_DELETED);
    NoContent.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_the_type() {
        assert_eq!(
            default_names("company"),
            ("Company".to_owned(), "Companies".to_owned())
        );
        assert_eq!(
            default_names("billing_account"),
            ("Billing account".to_owned(), "Billing accounts".to_owned())
        );
        assert_eq!(default_names("box"), ("Box".to_owned(), "Boxes".to_owned()));
        assert_eq!(default_names("day"), ("Day".to_owned(), "Days".to_owned()));
    }
}
