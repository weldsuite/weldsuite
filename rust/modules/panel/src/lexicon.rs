//! `/api/panel/lexicon` (`routes/lexicon/index.ts`, `services/lexicon.ts`):
//! the event and property names seen in the data (last 30 days, a scan
//! cached about an hour) merged with the team's definitions
//! (`panel_event_definitions`: description, hidden, verified).
//!
//!   GET   /?projectId=  → names seen merged with definitions (`panel_reports:read`)
//!   PATCH /             → describe, hide or verify a name; creates the definition (`panel_reports:update`)

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    PANEL_EVENT_DEFINITION_CREATED, PANEL_EVENT_DEFINITION_UPDATED,
};
use weldsuite_kit::{ApiError, Data};
use weldsuite_panel_domain::query::Runner;
use weldsuite_panel_domain::query::activity::run_lexicon_scan;
use weldsuite_panel_domain::schemas::PanelQuerySpec;
use weldsuite_ports::Cache;
use weldsuite_zod::{Keys, S, Z};

use crate::projects::live_project;
use crate::query::{QueryDeps, QueryFailure};
use crate::schemas_gen::{PANEL_QUERY_SPEC, UPDATE_PANEL_LEXICON};
use crate::{Caller, PanelState, unexpected};

/// How long a names-seen scan is cached (`LEXICON_CACHE_SECONDS`).
const LEXICON_CACHE_TTL: Duration = Duration::from_secs(3600);

/// `z.object({ projectId: z.string().min(1).max(30) })`.
const LIST_QUERY: Z = Z::Obj(
    &[("projectId", Z::Str(&[S::Min(1, None), S::Max(30, None)]))],
    Keys::Strip,
);

/// `lexiconCacheKey`.
fn cache_key(workspace_id: &str, project_id: &str) -> String {
    format!("panel:lexicon:{workspace_id}:{project_id}")
}

/// `entry(name, seen, count, def)`.
fn entry(name: &str, seen: bool, count: Option<&Value>, definition: Option<&Value>) -> Value {
    let field = |key: &str| definition.and_then(|d| d.get(key)).filter(|v| !v.is_null());
    json!({
        "name": name,
        "seen": seen,
        "count30d": count.cloned().unwrap_or(Value::Null),
        "description": field("description").cloned().unwrap_or(Value::Null),
        "hidden": field("hidden").cloned().unwrap_or(Value::Bool(false)),
        "verified": field("verified").cloned().unwrap_or(Value::Bool(false)),
        "definitionId": field("id").cloned().unwrap_or(Value::Null),
    })
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A scan's events (`{ name, count }`) and properties (names).
fn scan_lists(scan: &Value) -> (&[Value], &[Value]) {
    let list = |key: &str| {
        scan.get(key)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
    };
    (list("events"), list("properties"))
}

/// `mergeLexicon`: names seen, then definitions of names not seen (a
/// verified event can be quiet for a month).
fn merge(scan: &Value, definitions: &[Value]) -> Value {
    let find = |kind: &str, name: &str| {
        definitions
            .iter()
            .find(|d| text(d, "kind") == kind && text(d, "name") == name)
    };
    let (seen_events, seen_properties) = scan_lists(scan);
    let mut events: Vec<Value> = seen_events
        .iter()
        .map(|e| {
            let name = text(e, "name");
            entry(name, true, e.get("count"), find("event", name))
        })
        .collect();
    let mut properties: Vec<Value> = seen_properties
        .iter()
        .map(|p| {
            let name = p.as_str().unwrap_or_default();
            entry(name, true, None, find("property", name))
        })
        .collect();
    for d in definitions {
        let name = text(d, "name");
        match text(d, "kind") {
            "event" if !seen_events.iter().any(|e| text(e, "name") == name) => {
                events.push(entry(name, false, None, Some(d)));
            }
            "property" if !seen_properties.iter().any(|p| p.as_str() == Some(name)) => {
                properties.push(entry(name, false, None, Some(d)));
            }
            _ => {}
        }
    }
    json!({
        "events": events,
        "properties": properties,
        "scannedAt": scan.get("scannedAt").cloned().unwrap_or(Value::Null),
    })
}

/// `definitionToEntry(d, scan)`.
fn definition_entry(definition: &Value, scan: Option<&Value>) -> Value {
    let name = text(definition, "name");
    let is_event = text(definition, "kind") == "event";
    let (events, properties) = scan.map(scan_lists).unwrap_or_default();
    let seen = if is_event {
        events.iter().any(|e| text(e, "name") == name)
    } else {
        properties.iter().any(|p| p.as_str() == Some(name))
    };
    let count = if is_event {
        events
            .iter()
            .find(|e| text(e, "name") == name)
            .and_then(|e| e.get("count"))
            .filter(|count| !count.is_null())
    } else {
        None
    };
    entry(name, scan.is_some() && seen, count, Some(definition))
}

/// `definitionEventData(d)`.
fn event_data(definition: &Value) -> Value {
    let field = |key: &str| definition.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "kind": field("kind"),
        "name": field("name"),
        "hidden": field("hidden"),
        "verified": field("verified"),
    })
}

/// `listDefinitions`: the project's definitions by name.
async fn list_definitions(caller: &Caller, project_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from panel_event_definitions d
         where d.project_id = $1 order by d.name asc",
    )
    .bind(project_id)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows.into_iter().map(weldsuite_db::js_row).collect())
}

/// The cached scan of the project, when there is one.
async fn cached_scan(deps: &QueryDeps, key: &str) -> Option<Value> {
    let cache = deps.cache.as_ref()?;
    match cache.get(key).await {
        Ok(Some(text)) => serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, "[panel-api] lexicon cache read failed");
            None
        }
    }
}

/// `loadNamesSeen`: the names seen, from the cache when fresh, else from
/// the engine. A broken cache costs a scan, never the request.
async fn names_seen(deps: &QueryDeps, project_id: &str) -> Result<Value, QueryFailure> {
    // The scan runs with the same scope as a query: erased ids and the
    // identity flag come from the context.
    let spec_value = weldsuite_zod::parse_issues(
        &PANEL_QUERY_SPEC,
        &json!({ "kind": "web", "projectId": project_id }),
    )
    .map_err(|issues| QueryFailure::Upstream(format!("the lexicon's spec: {issues:?}")))?;
    let spec: PanelQuerySpec =
        serde_json::from_value(Value::Object(spec_value.body)).map_err(QueryFailure::upstream)?;
    let ctx = deps.context(project_id, &spec).await?;

    let key = cache_key(&deps.workspace_id, project_id);
    if let Some(scan) = cached_scan(deps, &key).await {
        return Ok(scan);
    }
    let engine = deps.engine()?;
    let runner = Runner::new(&engine);
    let scan = run_lexicon_scan(&ctx, &runner).await?;
    let scan = weldsuite_panel_domain::js::json_numbers(
        serde_json::to_value(&scan).map_err(QueryFailure::upstream)?,
    );
    if let Some(cache) = &deps.cache
        && let Err(error) = cache
            .put(&key, &scan.to_string(), Some(LEXICON_CACHE_TTL))
            .await
    {
        tracing::warn!(%error, "[panel-api] lexicon cache write failed");
    }
    Ok(scan)
}

/// `GET /?projectId=`.
pub(crate) async fn list(
    State(state): State<PanelState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    let definitions = match list_definitions(&caller, &project_id).await {
        Ok(definitions) => definitions,
        Err(error) => return unexpected(&error, "list definitions"),
    };
    let deps = QueryDeps::new(&caller, &state);
    match names_seen(&deps, &project_id).await {
        Ok(scan) => Data(merge(&scan, &definitions)).into_response(),
        Err(QueryFailure::Query(message)) => ApiError::bad_request(message).into_response(),
        // Without the analytics store the lexicon still shows what the team defined.
        Err(QueryFailure::Unavailable) => {
            let empty = json!({ "events": [], "properties": [], "scannedAt": deps.now_iso() });
            Data(merge(&empty, &definitions)).into_response()
        }
        Err(QueryFailure::Upstream(error)) => {
            tracing::error!(%error, "[panel-api] lexicon scan failed");
            ApiError::bad_gateway()
                .with_message("The analytics store did not answer")
                .into_response()
        }
    }
}

/// `upsertDefinition`: creates or changes a definition; only the fields
/// given change. The definition and whether it was created.
async fn upsert(
    caller: &Caller,
    input: &serde_json::Map<String, Value>,
) -> Result<(Value, bool), sqlx::Error> {
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from panel_event_definitions
         where project_id = $1 and kind = $2 and name = $3 limit 1",
    )
    .bind(project_id)
    .bind(kind)
    .bind(name)
    .fetch_optional(&caller.db)
    .await?;
    // `description` may be given as null (cleared); left out, it stays.
    let description = input.get("description");
    let hidden = input.get("hidden").and_then(Value::as_bool);
    let verified = input.get("verified").and_then(Value::as_bool);
    let row: Value = sqlx::query_scalar(
        "insert into panel_event_definitions as d
           (id, project_id, kind, name, description, hidden, verified, updated_by_user_id)
         values ($1, $2, $3, $4, $5, coalesce($7, false), coalesce($8, false), $9)
         on conflict (project_id, kind, name) do update set
           description = case when $6 then excluded.description else d.description end,
           hidden = coalesce($7, d.hidden),
           verified = coalesce($8, d.verified),
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = now()
         returning to_jsonb(d)",
    )
    .bind(weldsuite_kit::id::generate_id("pne"))
    .bind(project_id)
    .bind(kind)
    .bind(name)
    .bind(description.and_then(Value::as_str))
    .bind(description.is_some())
    .bind(hidden)
    .bind(verified)
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await?;
    Ok((weldsuite_db::js_row(row), existing.is_none()))
}

/// `PATCH /`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&UPDATE_PANEL_LEXICON, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    let (definition, created) = match upsert(&caller, &parsed.body).await {
        Ok(result) => result,
        Err(error) => return unexpected(&error, "upsert definition"),
    };
    caller.publish(
        &state,
        if created {
            PANEL_EVENT_DEFINITION_CREATED
        } else {
            PANEL_EVENT_DEFINITION_UPDATED
        },
        text(&definition, "id"),
        &event_data(&definition),
    );
    // The entry is still right without the cache; it just cannot say
    // whether the name was seen.
    let deps = QueryDeps::new(&caller, &state);
    let scan = cached_scan(&deps, &cache_key(&caller.workspace_id, &project_id)).await;
    Data(definition_entry(&definition, scan.as_ref())).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_names_seen_with_definitions() {
        let scan = json!({
            "events": [{ "name": "Signed up", "count": 12 }],
            "properties": ["plan"],
            "scannedAt": "2026-11-18T10:00:00.000Z"
        });
        let definitions = [
            json!({ "id": "pne_1", "kind": "event", "name": "Signed up", "description": "Account created", "hidden": false, "verified": true }),
            json!({ "id": "pne_2", "kind": "event", "name": "Old event", "description": null, "hidden": true, "verified": false }),
        ];
        let merged = merge(&scan, &definitions);
        assert_eq!(
            merged["events"],
            json!([
                { "name": "Signed up", "seen": true, "count30d": 12, "description": "Account created", "hidden": false, "verified": true, "definitionId": "pne_1" },
                { "name": "Old event", "seen": false, "count30d": null, "description": null, "hidden": true, "verified": false, "definitionId": "pne_2" }
            ])
        );
        assert_eq!(
            merged["properties"],
            json!([{ "name": "plan", "seen": true, "count30d": null, "description": null, "hidden": false, "verified": false, "definitionId": null }])
        );
        assert_eq!(
            definition_entry(&definitions[0], Some(&scan))["count30d"],
            12
        );
        assert_eq!(definition_entry(&definitions[1], None)["seen"], false);
    }
}
