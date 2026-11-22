//! `/api/panel/dashboards` (`routes/dashboards/index.ts`): a grid of tiles,
//! each showing a saved report or its own Markdown text, with optional
//! dashboard-wide filters. Same visibility rule as reports.
//!
//!   GET    /                      → visible dashboards (?projectId, ?scope)
//!   POST   /                      → new dashboard
//!   GET    /templates             → the built-in templates (?locale, else Accept-Language)
//!   POST   /from-template         → a dashboard and its reports from a template
//!   GET    /:id                   → dashboard, tiles (with the spec each report tile runs) and the visible reports
//!   PATCH  /:id                   → name, description, visibility, filters
//!   DELETE /:id                   → soft delete (tiles go with it)
//!   POST   /:id/tiles             → add a report tile or a text tile
//!   PATCH  /:id/tiles/:tileId     → move or resize a tile, or change a text tile's text
//!   DELETE /:id/tiles/:tileId     → remove a tile
//!   PUT    /:id/layout            → move and resize every tile at once
//!
//! Tile and filter changes are an `updated` event on the dashboard (never
//! carrying the filters or the text).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::ACCEPT_LANGUAGE;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_DASHBOARD_CREATED, PANEL_DASHBOARD_DELETED, PANEL_DASHBOARD_UPDATED,
    PANEL_REPORT_CREATED,
};
use weldsuite_db::{OrmConn, PgPool, orm, orm_error};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::{
    panel_dashboard_tiles as tiles, panel_dashboards as dashboards, panel_reports as reports,
};
use weldsuite_zod::{Keys, Z};

use crate::saved::{
    Actor, PROJECT_ID, SCOPES, can_change, can_see, dashboard_detail, dashboard_dto,
    dashboard_event_data, field, get_dashboard, get_report, list_tiles, project_exists,
    report_event_data, stored_filters, text, tile_dto,
};
use crate::schemas_gen::{
    ADD_PANEL_DASHBOARD_TILE, CREATE_PANEL_DASHBOARD, CREATE_PANEL_DASHBOARD_FROM_TEMPLATE,
    SET_PANEL_DASHBOARD_LAYOUT, UPDATE_PANEL_DASHBOARD, UPDATE_PANEL_DASHBOARD_TILE,
};
use crate::templates::{
    LOCALES, Template, TemplateTile, find_template, template_dto, template_locale,
    template_report_spec, templates,
};
use crate::{Caller, PanelState, unexpected};

const LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", Z::Opt(&PROJECT_ID)),
        ("scope", Z::Opt(&Z::Enum(SCOPES, None))),
    ],
    Keys::Strip,
);

const TEMPLATES_QUERY: Z = Z::Obj(&[("locale", Z::Opt(&Z::Enum(LOCALES, None)))], Keys::Strip);

/// A row as Drizzle returns it.
fn js_row<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `scopeCondition(scope, userId)` on dashboards: `mine`, `shared`, or both.
fn scope_condition(user_id: &str, scope: &str) -> Condition {
    let mine = dashboards::Column::OwnerUserId.eq(user_id);
    let shared = dashboards::Column::Visibility.eq("workspace");
    match scope {
        "mine" => Condition::all().add(mine),
        "shared" => Condition::all().add(shared),
        _ => Condition::any().add(mine).add(shared),
    }
}

fn publish(caller: &Caller, state: &PanelState, dashboard: &Value, event: EventName) {
    caller.publish(
        state,
        event,
        text(dashboard, "id"),
        &dashboard_event_data(dashboard),
    );
}

fn accept_language(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
}

/// `editable(c)`: a dashboard the caller may change, or the answer instead.
async fn editable(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    match get_dashboard(&caller.db, id).await {
        Ok(Some(dashboard)) if can_see(&dashboard, actor) => {
            if can_change(&dashboard, actor) {
                Ok(dashboard)
            } else {
                Err(Box::new(
                    ApiError::forbidden()
                        .with_message("Only the owner can change this dashboard")
                        .into_response(),
                ))
            }
        }
        Ok(_) => Err(Box::new(
            ApiError::not_found("Dashboard", Some(id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get dashboard"))),
    }
}

/// `updateDashboard(db, id, input)`: only the given fields change; the row
/// after, or `None` when it is gone.
async fn update_dashboard(
    db: &PgPool,
    id: &str,
    input: &Map<String, Value>,
) -> Result<Option<Value>, DbErr> {
    let mut update = dashboards::Entity::update_many();
    if let Some(name) = input.get("name").and_then(Value::as_str) {
        update = update.col_expr(dashboards::Column::Name, Expr::value(name));
    }
    if input.contains_key("description") {
        let description = input.get("description").and_then(Value::as_str);
        update = update.col_expr(
            dashboards::Column::Description,
            Expr::value(description.map(str::to_owned)),
        );
    }
    if let Some(visibility) = input.get("visibility").and_then(Value::as_str) {
        update = update.col_expr(dashboards::Column::Visibility, Expr::value(visibility));
    }
    if let Some(filters) = input.get("filters") {
        let filters = stored_filters(Some(filters));
        update = update.col_expr(
            dashboards::Column::Filters,
            Expr::value((!filters.is_null()).then_some(filters)),
        );
    }
    update
        .col_expr(dashboards::Column::UpdatedAt, Expr::current_timestamp())
        .filter(dashboards::Column::Id.eq(id))
        .filter(dashboards::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(js_row)
        .transpose()
}

/// `updateDashboard(db, id, {})` after a tile change, and its `updated` event.
async fn touch(
    caller: &Caller,
    state: &PanelState,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let dashboard = update_dashboard(&caller.db, id, &Map::new()).await?;
    if let Some(dashboard) = &dashboard {
        publish(caller, state, dashboard, PANEL_DASHBOARD_UPDATED);
    }
    Ok(dashboard)
}

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let mut find = dashboards::Entity::find()
        .filter(dashboards::Column::DeletedAt.is_null())
        .filter(scope_condition(
            &actor.user_id,
            query.text("scope").unwrap_or("all"),
        ));
    if let Some(project_id) = query.text("projectId") {
        find = find.filter(dashboards::Column::ProjectId.eq(project_id));
    }
    let found = find
        .order_by_desc(dashboards::Column::UpdatedAt)
        .limit(500)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match found {
        Ok(found) => {
            let dashboards: Vec<Value> = found.iter().map(dashboard_dto).collect();
            let count = dashboards.len() as u64;
            List::new(dashboards, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list dashboards"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_DASHBOARD, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create dashboard"),
    }
    let filters = stored_filters(input.get("filters"));
    let created = dashboards::Entity::insert(dashboards::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnd")),
        project_id: Set(project_id.clone()),
        name: Set(input.text("name").unwrap_or_default().to_owned()),
        description: Set(input
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)),
        owner_user_id: Set(caller.user_id.clone()),
        visibility: Set(input.text("visibility").unwrap_or("private").to_owned()),
        filters: Set((!filters.is_null()).then_some(filters)),
        template: Set(None),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    match created {
        Ok(dashboard) => {
            publish(&caller, &state, &dashboard, PANEL_DASHBOARD_CREATED);
            Created(dashboard_dto(&dashboard)).into_response()
        }
        Err(error) => unexpected(&error, "create dashboard"),
    }
}

/// `GET /templates`.
pub(crate) async fn list_templates(headers: HeaderMap, RawQuery(raw): RawQuery) -> Response {
    let query = match weldsuite_zod::query(&TEMPLATES_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let locale = template_locale(query.text("locale"), accept_language(&headers));
    let dtos: Vec<Value> = templates()
        .iter()
        .map(|template| template_dto(template, locale))
        .collect();
    let count = dtos.len() as u64;
    List::new(dtos, Pagination::new(count, false, None)).into_response()
}

/// What `createFromTemplate` wrote.
struct FromTemplate {
    dashboard: Value,
    reports: Vec<Value>,
}

/// A tile a template adds.
struct NewTile {
    id: String,
    kind: &'static str,
    report_id: Option<String>,
    text: Option<&'static str>,
    layout: Value,
}

/// A report a template adds: its id, parsed spec and name.
struct NewReport {
    id: String,
    spec: Map<String, Value>,
    name: &'static str,
}

/// The template's tiles and the reports behind them, for `project_id` in
/// `locale` (a report none of whose specs parse is left out with its tile).
fn plan_template(
    template: &Template,
    project_id: &str,
    locale: &str,
) -> (Vec<NewTile>, Vec<NewReport>) {
    let mut tiles = Vec::new();
    let mut reports = Vec::new();
    for tile in &template.tiles {
        match tile {
            TemplateTile::Text { text, layout } => tiles.push(NewTile {
                id: weldsuite_kit::id::generate_id("pnt"),
                kind: "text",
                report_id: None,
                text: Some(text.get(locale)),
                layout: layout.to_json(),
            }),
            TemplateTile::Report { report, layout } => {
                let Some(spec) = template_report_spec(report, project_id) else {
                    continue;
                };
                let report_id = weldsuite_kit::id::generate_id("pnr");
                reports.push(NewReport {
                    id: report_id.clone(),
                    spec,
                    name: report.name.get(locale),
                });
                tiles.push(NewTile {
                    id: weldsuite_kit::id::generate_id("pnt"),
                    kind: "report",
                    report_id: Some(report_id),
                    text: None,
                    layout: layout.to_json(),
                });
            }
        }
    }
    (tiles, reports)
}

/// `createFromTemplate`: the template's reports, the dashboard and its tiles
/// in one transaction; every report and the dashboard get `visibility`.
async fn create_from_template(
    caller: &Caller,
    template: &Template,
    input: &Map<String, Value>,
    locale: &str,
) -> Result<FromTemplate, DbErr> {
    let text_of = |key: &str| input.get(key).and_then(Value::as_str);
    let project_id = text_of("projectId").unwrap_or_default();
    let visibility = text_of("visibility").unwrap_or("private");
    let name = text_of("name").unwrap_or_else(|| template.name.get(locale));
    let dashboard_id = weldsuite_kit::id::generate_id("pnd");
    // Tiles are listed by creation time: a millisecond apart keeps the template's order.
    let start = caller.now().unwrap_or_else(js::now_millis);
    let (tiles, new_reports) = plan_template(template, project_id, locale);

    let mut tx = caller.db.begin().await.map_err(orm_error)?;
    let written = {
        let conn = OrmConn::new(&mut tx);
        let written = Written {
            caller,
            template,
            dashboard_id: &dashboard_id,
            project_id,
            visibility,
            name,
            locale,
            start,
        };
        write_template(&conn, &written, tiles, new_reports).await?
    };
    tx.commit().await.map_err(orm_error)?;
    Ok(written)
}

/// What every row a template writes shares.
struct Written<'a> {
    caller: &'a Caller,
    template: &'a Template,
    dashboard_id: &'a str,
    project_id: &'a str,
    visibility: &'a str,
    name: &'a str,
    locale: &'a str,
    /// The first tile's creation time (milliseconds).
    start: i64,
}

/// The template's reports, its dashboard and the tiles, in that order, on
/// the transaction's connection.
async fn write_template(
    conn: &impl ConnectionTrait,
    written: &Written<'_>,
    tiles: Vec<NewTile>,
    new_reports: Vec<NewReport>,
) -> Result<FromTemplate, DbErr> {
    let &Written {
        caller,
        template,
        dashboard_id,
        project_id,
        visibility,
        name,
        locale,
        start,
    } = written;
    let mut created = Vec::with_capacity(new_reports.len());
    for report in new_reports {
        // `kind` is not null: a spec without one fails as the insert did.
        let kind = report
            .spec
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| DbErr::Custom("a template report without a kind".to_owned()))?;
        let row = reports::Entity::insert(reports::ActiveModel {
            id: Set(report.id),
            project_id: Set(project_id.to_owned()),
            kind: Set(kind),
            name: Set(report.name.to_owned()),
            description: Set(None),
            spec: Set(Value::Object(report.spec)),
            owner_user_id: Set(caller.user_id.clone()),
            visibility: Set(visibility.to_owned()),
            ..Default::default()
        })
        .exec_with_returning(conn)
        .await?;
        created.push(js_row(row)?);
    }
    let dashboard = dashboards::Entity::insert(dashboards::ActiveModel {
        id: Set(dashboard_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        name: Set(name.to_owned()),
        description: Set(Some(template.description.get(locale).to_owned())),
        owner_user_id: Set(caller.user_id.clone()),
        visibility: Set(visibility.to_owned()),
        filters: Set(None),
        template: Set(Some(template.id.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(conn)
    .await?;
    for (offset, tile) in tiles.into_iter().enumerate() {
        let millis = start + i64::try_from(offset).unwrap_or(0);
        let created_at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
            .map_err(|error| DbErr::Custom(error.to_string()))?;
        tiles::Entity::insert(tiles::ActiveModel {
            id: Set(tile.id),
            dashboard_id: Set(dashboard_id.to_owned()),
            kind: Set(tile.kind.to_owned()),
            report_id: Set(tile.report_id),
            text: Set(tile.text.map(str::to_owned)),
            layout: Set(tile.layout),
            created_at: Set(created_at),
        })
        .exec_without_returning(conn)
        .await?;
    }
    Ok(FromTemplate {
        dashboard: js_row(dashboard)?,
        reports: created,
    })
}

/// `POST /from-template`.
pub(crate) async fn from_template(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_DASHBOARD_FROM_TEMPLATE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create dashboard from template"),
    }
    let template_id = input.text("template").unwrap_or_default().to_owned();
    let Some(template) = find_template(&template_id) else {
        return ApiError::not_found("Template", Some(&template_id)).into_response();
    };
    let locale = template_locale(input.text("locale"), accept_language(&headers));
    let created = match create_from_template(&caller, &template, &input.body, locale).await {
        Ok(created) => created,
        Err(error) => return unexpected(&error, "create dashboard from template"),
    };
    for report in &created.reports {
        caller.publish(
            &state,
            PANEL_REPORT_CREATED,
            text(report, "id"),
            &report_event_data(report),
        );
    }
    publish(&caller, &state, &created.dashboard, PANEL_DASHBOARD_CREATED);
    let actor = Actor::of(&caller, &permissions);
    match dashboard_detail(&caller.db, &created.dashboard, &actor).await {
        Ok(detail) => Created(detail).into_response(),
        Err(error) => unexpected(&error, "create dashboard from template"),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let dashboard = match get_dashboard(&caller.db, &id).await {
        Ok(Some(dashboard)) if can_see(&dashboard, &actor) => dashboard,
        Ok(_) => return ApiError::not_found("Dashboard", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "get dashboard"),
    };
    match dashboard_detail(&caller.db, &dashboard, &actor).await {
        Ok(detail) => Data(detail).into_response(),
        Err(error) => unexpected(&error, "get dashboard"),
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_DASHBOARD, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match update_dashboard(&caller.db, text(&found, "id"), &input.body).await {
        Ok(Some(dashboard)) => {
            publish(&caller, &state, &dashboard, PANEL_DASHBOARD_UPDATED);
            Data(dashboard_dto(&dashboard)).into_response()
        }
        Ok(None) => ApiError::not_found("Dashboard", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "update dashboard"),
    }
}

/// `DELETE /:id`: soft delete; its tiles go with it.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let found_id = text(&found, "id").to_owned();
    let db = orm(&caller.db);
    let deleted = dashboards::Entity::update_many()
        .col_expr(dashboards::Column::DeletedAt, Expr::current_timestamp())
        .col_expr(dashboards::Column::UpdatedAt, Expr::current_timestamp())
        .filter(dashboards::Column::Id.eq(&found_id))
        .filter(dashboards::Column::DeletedAt.is_null())
        .exec_with_returning(&db)
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    let dashboard = match deleted {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Dashboard", Some(&found_id)).into_response(),
        Err(error) => return unexpected(&error, "delete dashboard"),
    };
    if let Err(error) = tiles::Entity::delete_many()
        .filter(tiles::Column::DashboardId.eq(&found_id))
        .exec(&db)
        .await
    {
        return unexpected(&error, "delete dashboard");
    }
    publish(&caller, &state, &dashboard, PANEL_DASHBOARD_DELETED);
    NoContent.into_response()
}

/// `POST /:id/tiles`: a report tile (of a report of the same project the
/// caller may see) or a text tile.
pub(crate) async fn add_tile(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&ADD_PANEL_DASHBOARD_TILE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let dashboard_id = text(&found, "id").to_owned();
    let layout = input.get("layout").cloned().unwrap_or(Value::Null);
    let (kind, report_id, tile_text) = if input.text("kind") == Some("text") {
        ("text", None, input.text("text").map(str::to_owned))
    } else {
        let wanted = input.text("reportId").unwrap_or_default().to_owned();
        let report = match get_report(&caller.db, &wanted).await {
            Ok(report) => report,
            Err(error) => return unexpected(&error, "add tile"),
        };
        // A report the caller cannot see, or one of another project, does not exist for them.
        match report {
            Some(report)
                if text(&report, "projectId") == text(&found, "projectId")
                    && can_see(&report, &actor) =>
            {
                ("report", Some(text(&report, "id").to_owned()), None)
            }
            _ => return ApiError::not_found("Report", Some(&wanted)).into_response(),
        }
    };
    let added = tiles::Entity::insert(tiles::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnt")),
        dashboard_id: Set(dashboard_id.clone()),
        kind: Set(kind.to_owned()),
        report_id: Set(report_id),
        text: Set(tile_text),
        layout: Set(layout),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    let tile = match added {
        Ok(row) => row,
        Err(error) => return unexpected(&error, "add tile"),
    };
    if let Err(error) = touch(&caller, &state, &dashboard_id).await {
        return unexpected(&error, "add tile");
    }
    Created(tile_dto(&tile)).into_response()
}

async fn get_tile(
    db: &PgPool,
    dashboard_id: &str,
    tile_id: &str,
) -> Result<Option<Value>, DbErr> {
    tiles::Entity::find_by_id(tile_id)
        .filter(tiles::Column::DashboardId.eq(dashboard_id))
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// `updateTile`: moves or resizes a tile, or changes a text tile's Markdown.
async fn update_tile(
    db: &PgPool,
    dashboard_id: &str,
    tile_id: &str,
    layout: Option<&Value>,
    tile_text: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    if layout.is_none() && tile_text.is_none() {
        // Nothing to set: the row as it is.
        return get_tile(db, dashboard_id, tile_id).await;
    }
    let mut update = tiles::Entity::update_many();
    if let Some(layout) = layout {
        update = update.col_expr(tiles::Column::Layout, Expr::value(layout.clone()));
    }
    if let Some(tile_text) = tile_text {
        update = update.col_expr(tiles::Column::Text, Expr::value(tile_text));
    }
    update
        .filter(tiles::Column::Id.eq(tile_id))
        .filter(tiles::Column::DashboardId.eq(dashboard_id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(js_row)
        .transpose()
}

/// `PATCH /:id/tiles/:tileId`.
pub(crate) async fn update_tile_route(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path((id, tile_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_DASHBOARD_TILE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let dashboard_id = text(&found, "id").to_owned();
    let existing = match get_tile(&caller.db, &dashboard_id, &tile_id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return ApiError::not_found("Tile", Some(&tile_id)).into_response(),
        Err(error) => return unexpected(&error, "update tile"),
    };
    let new_text = input.get("text").and_then(Value::as_str);
    if new_text.is_some() && text(&existing, "kind") != "text" {
        return ApiError::bad_request("Only a text tile has text").into_response();
    }
    let tile = match update_tile(
        &caller.db,
        &dashboard_id,
        &tile_id,
        input.get("layout"),
        new_text,
    )
    .await
    {
        Ok(Some(tile)) => tile,
        Ok(None) => return ApiError::not_found("Tile", Some(&tile_id)).into_response(),
        Err(error) => return unexpected(&error, "update tile"),
    };
    if let Err(error) = touch(&caller, &state, &dashboard_id).await {
        return unexpected(&error, "update tile");
    }
    Data(tile_dto(&tile)).into_response()
}

/// `DELETE /:id/tiles/:tileId`.
pub(crate) async fn remove_tile(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path((id, tile_id)): Path<(String, String)>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let dashboard_id = text(&found, "id").to_owned();
    let removed = tiles::Entity::delete_many()
        .filter(tiles::Column::Id.eq(&tile_id))
        .filter(tiles::Column::DashboardId.eq(&dashboard_id))
        .exec(&orm(&caller.db))
        .await;
    match removed {
        Ok(done) if done.rows_affected > 0 => {}
        Ok(_) => return ApiError::not_found("Tile", Some(&tile_id)).into_response(),
        Err(error) => return unexpected(&error, "remove tile"),
    }
    if let Err(error) = touch(&caller, &state, &dashboard_id).await {
        return unexpected(&error, "remove tile");
    }
    NoContent.into_response()
}

/// `PUT /:id/layout`: every listed tile's layout; one tile that is not on
/// the dashboard changes nothing.
pub(crate) async fn set_layout(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&SET_PANEL_DASHBOARD_LAYOUT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let dashboard_id = text(&found, "id").to_owned();
    let existing = match list_tiles(&caller.db, &dashboard_id).await {
        Ok(existing) => existing,
        Err(error) => return unexpected(&error, "set layout"),
    };
    let wanted = input
        .get("tiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !wanted
        .iter()
        .all(|tile| existing.iter().any(|t| text(t, "id") == text(tile, "id")))
    {
        return ApiError::bad_request("A tile is not on this dashboard").into_response();
    }
    for tile in &wanted {
        let layout = field(tile, "layout");
        if let Err(error) = update_tile(
            &caller.db,
            &dashboard_id,
            text(tile, "id"),
            Some(&layout),
            None,
        )
        .await
        {
            return unexpected(&error, "set layout");
        }
    }
    let dashboard = match update_dashboard(&caller.db, &dashboard_id, &Map::new()).await {
        Ok(Some(dashboard)) => dashboard,
        Ok(None) => return ApiError::not_found("Dashboard", Some(&dashboard_id)).into_response(),
        Err(error) => return unexpected(&error, "set layout"),
    };
    publish(&caller, &state, &dashboard, PANEL_DASHBOARD_UPDATED);
    match dashboard_detail(&caller.db, &dashboard, &actor).await {
        Ok(detail) => Data(detail).into_response(),
        Err(error) => unexpected(&error, "set layout"),
    }
}
