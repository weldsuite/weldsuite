//! What reports, dashboards, cohorts and the objects that hang off them share
//! (`services/saved-objects.ts`, `services/dashboard-filters.ts`): the rows
//! (the entities, read as Drizzle reads them), their DTOs and event payloads, the
//! visibility rule and the dashboard filters every report tile runs with.
//!
//! Visibility: a `private` report or dashboard is its owner's alone (anyone
//! else gets a 404, admins included); `workspace` ones are everybody's with
//! `panel_reports:read`. Changing or deleting is for the owner, or for
//! someone with `panel_projects:manage` on a shared object.

use std::collections::HashSet;

use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::PANEL_PROJECTS_MANAGE;
use weldsuite_db::{PgPool, orm};
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::{panel_dashboard_tiles, panel_dashboards, panel_projects, panel_reports};
use weldsuite_zod::{Keys, S, Z};

use crate::Caller;
use crate::schemas_gen::{PANEL_DASHBOARD_FILTERS, PANEL_QUERY_SPEC, PANEL_REPORT_SPEC};

/// `PANEL_REPORT_SPEC_KINDS`: the kinds a saved report may have.
pub(crate) const REPORT_SPEC_KINDS: &[&str] = &[
    "web",
    "trends",
    "funnel",
    "retention",
    "flows",
    "stickiness",
    "lifecycle",
    "vitals",
    "impact",
    "signal",
];

/// `scope`: `all` (the caller's and the shared ones), `mine` or `shared`.
pub(crate) const SCOPES: &[&str] = &["all", "mine", "shared"];

/// `z.string().min(1).max(30)`: a project id in a query string.
pub(crate) const PROJECT_ID: Z = Z::Str(&[S::Min(1, None), S::Max(30, None)]);

/// `z.object({ projectId: z.string().min(1).max(30) })`.
pub(crate) const PROJECT_QUERY: Z = Z::Obj(&[("projectId", PROJECT_ID)], Keys::Strip);

/// A JSON value's text field, `""` when it has none.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A JSON value's field, `null` when it has none.
pub(crate) fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// Who acts (`Actor`): the user, and whether they hold
/// `panel_projects:manage` (may change shared objects of others).
#[derive(Debug, Clone)]
pub(crate) struct Actor {
    pub(crate) user_id: String,
    pub(crate) can_manage: bool,
}

impl Actor {
    /// `actorOf(c)`.
    pub(crate) fn of(caller: &Caller, permissions: &Permissions) -> Self {
        Self {
            user_id: caller.user_id.clone(),
            can_manage: permissions.has_any(&[PANEL_PROJECTS_MANAGE]),
        }
    }
}

/// `canSee(object, actor)`: its owner, or anyone when it is shared.
pub(crate) fn can_see(row: &Value, actor: &Actor) -> bool {
    text(row, "ownerUserId") == actor.user_id || text(row, "visibility") == "workspace"
}

/// `canChange(object, actor)`: its owner, or a manager when it is shared.
pub(crate) fn can_change(row: &Value, actor: &Actor) -> bool {
    text(row, "ownerUserId") == actor.user_id
        || (text(row, "visibility") == "workspace" && actor.can_manage)
}

/// An entity's row as Drizzle returns it: the entity serializes as Drizzle
/// did.
pub(crate) fn js_row(model: impl Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// Entity rows as Drizzle returns them, in order.
pub(crate) fn js_rows<M: Serialize>(models: Vec<M>) -> Result<Vec<Value>, DbErr> {
    models.into_iter().map(js_row).collect()
}

/// An epoch-millisecond moment (`new Date(ms)`) as a `timestamptz` value.
pub(crate) fn instant(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `projectExists(db, projectId)`: a live project of this tenant.
pub(crate) async fn project_exists(db: &PgPool, project_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = panel_projects::Entity::find_by_id(project_id)
        .filter(panel_projects::Column::DeletedAt.is_null())
        .select_only()
        .column(panel_projects::Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `scopeCondition(scope, userId)` on an owned, shared object: `mine` is
/// the user's own, `shared` the workspace's, anything else both.
pub(crate) fn scope_filter(
    owner: impl ColumnTrait,
    visibility: impl ColumnTrait,
    user_id: &str,
    scope: &str,
) -> Condition {
    match scope {
        "mine" => Condition::all().add(owner.eq(user_id)),
        "shared" => Condition::all().add(visibility.eq("workspace")),
        _ => Condition::any()
            .add(owner.eq(user_id))
            .add(visibility.eq("workspace")),
    }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/// `toReportDto(r)`.
pub(crate) fn report_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "kind": field(row, "kind"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "spec": field(row, "spec"),
        "ownerUserId": field(row, "ownerUserId"),
        "visibility": field(row, "visibility"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `reportEventData(r)`: never the spec.
pub(crate) fn report_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "kind": field(row, "kind"),
        "visibility": field(row, "visibility"),
    })
}

/// `getReport(db, id)`: a live report.
pub(crate) async fn get_report(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    panel_reports::Entity::find_by_id(id)
        .filter(panel_reports::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// The live reports with these ids, in the order the database returns them
/// (`inArray`, no order).
pub(crate) async fn reports_by_id(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let found = panel_reports::Entity::find()
        .filter(panel_reports::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(panel_reports::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    js_rows(found)
}

// ---------------------------------------------------------------------------
// Dashboards and their filters
// ---------------------------------------------------------------------------

/// `parseDashboardFilters(raw)`: stored filters as the query schema reads
/// them; `None` for none, nothing set, or a shape that no longer parses.
pub(crate) fn parse_dashboard_filters(raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|raw| !raw.is_null())?;
    if raw == &Value::Bool(false) || raw.as_str() == Some("") {
        return None;
    }
    let parsed = weldsuite_zod::parse_issues(&PANEL_DASHBOARD_FILTERS, raw).ok()?;
    let has_range = parsed
        .body
        .get("dateRange")
        .is_some_and(|range| !range.is_null());
    let has_filters = parsed
        .body
        .get("filters")
        .and_then(Value::as_array)
        .is_some_and(|filters| !filters.is_empty());
    (has_range || has_filters).then_some(Value::Object(parsed.body))
}

/// `storedFilters(input)`: the filters as stored, `null` when they set
/// nothing (no date range, no filters).
pub(crate) fn stored_filters(input: Option<&Value>) -> Value {
    let Some(input) = input.filter(|input| !input.is_null()) else {
        return Value::Null;
    };
    match weldsuite_zod::parse_issues(&PANEL_DASHBOARD_FILTERS, input) {
        Ok(parsed) => {
            let has_range = parsed.body.get("dateRange").is_some();
            let has_filters = parsed
                .body
                .get("filters")
                .and_then(Value::as_array)
                .is_some_and(|filters| !filters.is_empty());
            if has_range || has_filters {
                Value::Object(parsed.body)
            } else {
                Value::Null
            }
        }
        // The route validated them with the same schema.
        Err(_) => Value::Null,
    }
}

/// `applyPanelDashboardFilters(spec, filters)`: the date range replaced, the
/// filters added after the report's own.
pub(crate) fn apply_dashboard_filters(spec: &Value, filters: Option<&Value>) -> Value {
    let Some(filters) = filters.filter(|f| !f.is_null()) else {
        return spec.clone();
    };
    let mut out = spec.as_object().cloned().unwrap_or_default();
    if let Some(range) = filters.get("dateRange").filter(|range| truthy(range)) {
        out.insert("dateRange".to_owned(), range.clone());
    }
    if let Some(added) = filters
        .get("filters")
        .and_then(Value::as_array)
        .filter(|added| !added.is_empty())
    {
        let mut all: Vec<Value> = spec
            .get("filters")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        all.extend(added.iter().cloned());
        out.insert("filters".to_owned(), Value::Array(all));
    }
    Value::Object(out)
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `tileSpec(reportSpec, filters, dateRange)`: the report's spec with the
/// dashboard's filters, then a viewer's preset, parsed by the query schema;
/// `None` when it does not parse.
pub(crate) fn tile_spec(
    report_spec: &Value,
    filters: Option<&Value>,
    date_range: Option<&Value>,
) -> Option<Map<String, Value>> {
    let mut merged = apply_dashboard_filters(report_spec, filters);
    if let (Some(range), Some(object)) = (date_range, merged.as_object_mut()) {
        object.insert("dateRange".to_owned(), range.clone());
    }
    weldsuite_zod::parse_issues(&PANEL_QUERY_SPEC, &merged)
        .ok()
        .map(|parsed| parsed.body)
}

/// `panelReportSpecSchema.safeParse(spec)`: the parsed spec, or `None`.
pub(crate) fn report_spec(spec: &Value) -> Option<Map<String, Value>> {
    weldsuite_zod::parse_issues(&PANEL_REPORT_SPEC, spec)
        .ok()
        .map(|parsed| parsed.body)
}

/// `toDashboardDto(d)`.
pub(crate) fn dashboard_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "ownerUserId": field(row, "ownerUserId"),
        "visibility": field(row, "visibility"),
        "filters": parse_dashboard_filters(row.get("filters")).unwrap_or(Value::Null),
        "template": field(row, "template"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `dashboardEventData(d)`: never the filters or a text tile's Markdown.
pub(crate) fn dashboard_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "visibility": field(row, "visibility"),
        "template": field(row, "template"),
    })
}

/// `toTileDto(t)`.
pub(crate) fn tile_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "dashboardId": field(row, "dashboardId"),
        "kind": field(row, "kind"),
        "reportId": field(row, "reportId"),
        "text": field(row, "text"),
        "layout": field(row, "layout"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `getDashboard(db, id)`: a live dashboard.
pub(crate) async fn get_dashboard(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    panel_dashboards::Entity::find_by_id(id)
        .filter(panel_dashboards::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// `listTiles(db, dashboardId)`: oldest first.
pub(crate) async fn list_tiles(db: &PgPool, dashboard_id: &str) -> Result<Vec<Value>, DbErr> {
    let found = panel_dashboard_tiles::Entity::find()
        .filter(panel_dashboard_tiles::Column::DashboardId.eq(dashboard_id))
        .order_by_asc(panel_dashboard_tiles::Column::CreatedAt)
        .order_by_asc(panel_dashboard_tiles::Column::Id)
        .all(&orm(db))
        .await?;
    js_rows(found)
}

/// `tileReports(db, tiles)`: the live reports behind the report tiles.
pub(crate) async fn tile_reports(db: &PgPool, tiles: &[Value]) -> Result<Vec<Value>, DbErr> {
    let mut seen = HashSet::new();
    let ids: Vec<String> = tiles
        .iter()
        .filter_map(|tile| tile.get("reportId").and_then(Value::as_str))
        .filter(|id| seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect();
    reports_by_id(db, &ids).await
}

/// The report of `id` in `reports`.
pub(crate) fn report_in<'a>(reports: &'a [Value], id: &str) -> Option<&'a Value> {
    reports.iter().find(|report| text(report, "id") == id)
}

/// `dashboardDetail(db, dashboard, actor)`: the dashboard, its tiles (each
/// report tile with the spec it runs, a tile of a report the actor may not
/// see left out) and the reports on them the actor may see.
pub(crate) async fn dashboard_detail(
    db: &PgPool,
    dashboard: &Value,
    actor: &Actor,
) -> Result<Value, DbErr> {
    let tiles = list_tiles(db, text(dashboard, "id")).await?;
    let reports = tile_reports(db, &tiles).await?;
    let visible: Vec<&Value> = reports.iter().filter(|r| can_see(r, actor)).collect();
    let filters = parse_dashboard_filters(dashboard.get("filters"));
    let mut detail_tiles = Vec::with_capacity(tiles.len());
    for tile in &tiles {
        let mut dto = tile_dto(tile);
        if text(tile, "kind") == "text" {
            dto["spec"] = Value::Null;
            detail_tiles.push(dto);
            continue;
        }
        let report = tile
            .get("reportId")
            .and_then(Value::as_str)
            .and_then(|id| visible.iter().find(|r| text(r, "id") == id));
        let Some(report) = report else {
            continue;
        };
        dto["spec"] = tile_spec(&field(report, "spec"), filters.as_ref(), None)
            .map_or(Value::Null, Value::Object);
        detail_tiles.push(dto);
    }
    let mut out = dashboard_dto(dashboard);
    out["tiles"] = Value::Array(detail_tiles);
    out["reports"] = Value::Array(visible.iter().map(|r| report_dto(r)).collect());
    Ok(out)
}

// ---------------------------------------------------------------------------
// Targets: what comments and share links attach to
// ---------------------------------------------------------------------------

/// A live report or dashboard (`PanelTarget`).
#[derive(Debug, Clone)]
pub(crate) struct Target {
    /// `report` or `dashboard`.
    pub(crate) target_type: &'static str,
    pub(crate) row: Value,
}

/// `getTarget(db, targetType, targetId)`.
pub(crate) async fn get_target(
    db: &PgPool,
    target_type: &str,
    target_id: &str,
) -> Result<Option<Target>, DbErr> {
    Ok(if target_type == "report" {
        get_report(db, target_id).await?.map(|row| Target {
            target_type: "report",
            row,
        })
    } else {
        get_dashboard(db, target_id).await?.map(|row| Target {
            target_type: "dashboard",
            row,
        })
    })
}

/// `Report` or `Dashboard`, for a 404's message.
pub(crate) fn target_label(target_type: &str) -> &'static str {
    if target_type == "report" {
        "Report"
    } else {
        "Dashboard"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_filters_replace_the_range_and_add_filters() {
        let spec = json!({
            "kind": "trends",
            "projectId": "pnp_a",
            "dateRange": { "preset": "30d" },
            "filters": [{ "source": "column", "field": "device_type", "operator": "eq", "value": "mobile" }]
        });
        let filters = json!({
            "dateRange": { "preset": "7d" },
            "filters": [{ "source": "column", "field": "country", "operator": "eq", "value": "NL" }]
        });
        let merged = apply_dashboard_filters(&spec, Some(&filters));
        assert_eq!(merged["dateRange"], json!({ "preset": "7d" }));
        assert_eq!(merged["filters"].as_array().map(Vec::len), Some(2));
        assert_eq!(apply_dashboard_filters(&spec, None), spec);
    }

    #[test]
    fn empty_filters_are_none() {
        assert_eq!(
            parse_dashboard_filters(Some(&json!({ "filters": [] }))),
            None
        );
        assert_eq!(stored_filters(Some(&json!({ "filters": [] }))), Value::Null);
        assert!(
            parse_dashboard_filters(Some(&json!({ "dateRange": { "preset": "7d" } }))).is_some()
        );
    }

    #[test]
    fn visibility_follows_owner_and_sharing() {
        let alice = Actor {
            user_id: "user_alice".to_owned(),
            can_manage: false,
        };
        let admin = Actor {
            user_id: "user_root".to_owned(),
            can_manage: true,
        };
        let private = json!({ "ownerUserId": "user_alice", "visibility": "private" });
        let shared = json!({ "ownerUserId": "user_bob", "visibility": "workspace" });
        assert!(can_see(&private, &alice) && can_change(&private, &alice));
        assert!(!can_see(&private, &admin));
        assert!(can_see(&shared, &alice) && !can_change(&shared, &alice));
        assert!(can_change(&shared, &admin));
    }
}
