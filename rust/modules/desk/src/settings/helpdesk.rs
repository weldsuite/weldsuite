//! `/api/helpdesk-settings` (`routes/helpdesk-settings/index.ts`): the
//! workspace's singleton `helpdesk_settings` row (one JSON blob per
//! section) and the legacy `helpdesk_widget_settings` widgets, which are
//! also registered in the master `widget_registry`.
//! Permissions `settings:read|create|update|delete`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Extension, Json, Router};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, Tenant, orm, utc_now};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::widget_registry;
use weldsuite_schema::tenant::{helpdesk_settings, helpdesk_widget_settings as widgets};

use super::tables::HELPDESK_WIDGET_SETTINGS as WIDGETS;
use super::{Opt, lenient_json, master, read_optional, stamp};
use crate::crud::write_failed;
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(overview).route_layer(need("settings:read")))
        .route(
            "/notifications",
            put(notifications).route_layer(need("settings:update")),
        )
        .route(
            "/automation",
            put(automation).route_layer(need("settings:update")),
        )
        .route(
            "/tickets",
            put(tickets).route_layer(need("settings:update")),
        )
        .route(
            "/satisfaction",
            put(satisfaction).route_layer(need("settings:update")),
        )
        .route(
            "/widget",
            get(primary_widget).route_layer(need("settings:read")),
        )
        .route(
            "/widget",
            put(save_primary).route_layer(need("settings:update")),
        )
        .route(
            "/widget/enabled",
            patch(toggle_enabled).route_layer(need("settings:update")),
        )
        .route(
            "/widgets",
            get(list_widgets).route_layer(need("settings:read")),
        )
        .route(
            "/widgets",
            post(create_widget).route_layer(need("settings:create")),
        )
        .route(
            "/widgets/{widget_id}",
            get(widget_detail).route_layer(need("settings:read")),
        )
        .route(
            "/widgets/{widget_id}",
            put(update_widget).route_layer(need("settings:update")),
        )
        .route(
            "/widgets/{widget_id}",
            delete(delete_widget).route_layer(need("settings:delete")),
        )
        .merge(super::priority_matrix::routes(gate))
}

// ── schemas ─────────────────────────────────────────────────────────────────

const WIDGET_FIELDS: &[(&str, Opt)] = &[
    ("widgetName", Opt::Str(None)),
    ("pageHome", Opt::Bool),
    ("pageChat", Opt::Bool),
    ("pageHelp", Opt::Bool),
    ("pageParcelTracking", Opt::Bool),
    ("pageChangelog", Opt::Bool),
    ("pageNews", Opt::Bool),
    ("pageFeedback", Opt::Bool),
    ("pageAnnouncements", Opt::Bool),
    ("pageEventSignUp", Opt::Bool),
    ("colorPrimary", Opt::Str(None)),
    ("colorButton", Opt::Str(None)),
    ("colorButtonText", Opt::Str(None)),
    ("colorLauncher", Opt::Str(None)),
    ("colorHeader", Opt::Str(None)),
    ("colorAccent", Opt::Str(None)),
    ("borderRadius", Opt::Str(None)),
    ("fontSize", Opt::Str(None)),
    ("typographyText", Opt::Str(None)),
    ("typographyBackground", Opt::Str(None)),
    ("startingPage", Opt::Str(None)),
    ("position", Opt::Str(None)),
    ("autoOpen", Opt::Bool),
    ("showWelcomeMessage", Opt::Bool),
    ("welcomeMessage", Opt::Str(None)),
    ("companyLogoUrl", Opt::Str(None)),
    ("chatBackgroundColor", Opt::Str(None)),
    ("userBubbleColor", Opt::Str(None)),
    ("userBubbleTextColor", Opt::Str(None)),
    ("agentBubbleColor", Opt::Str(None)),
    ("agentBubbleTextColor", Opt::Str(None)),
    ("showBranding", Opt::Bool),
    (
        "emailCollection",
        Opt::Choice(&["none", "outside_office_hours", "always"]),
    ),
];

const TICKET_FIELDS: &[(&str, Opt)] = &[
    ("autoAssignment", Opt::Bool),
    ("requireApproval", Opt::Bool),
    ("allowCustomerCreation", Opt::Bool),
    ("defaultPriority", Opt::Str(None)),
    ("defaultStatus", Opt::Str(None)),
    ("autoCloseAfterDays", Opt::Num),
    ("mergeThreshold", Opt::Num),
    (
        "assignmentStrategy",
        Opt::Choice(&["round_robin", "least_busy", "manual"]),
    ),
];

const SATISFACTION_FIELDS: &[(&str, Opt)] = &[
    ("enableSurveys", Opt::Bool),
    ("sendAfterResolution", Opt::Bool),
    ("delayMinutes", Opt::Num),
    ("surveyTemplate", Opt::Str(None)),
    ("thankYouMessage", Opt::Str(None)),
];

const NOTIFY_FLAGS: [&str; 5] = [
    "notifyOnNewTicket",
    "notifyOnAssignment",
    "notifyOnStatusChange",
    "notifyOnCustomerReply",
    "notifyOnSLABreach",
];

fn read_widget(headers: &HeaderMap, body: &Bytes) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        let mut data = Map::new();
        read_optional(issues, fields, WIDGET_FIELDS, &mut data);
        data
    })
}

// ── the singleton ───────────────────────────────────────────────────────────

/// A row as Drizzle returns it.
fn js<T: serde::Serialize>(row: Option<T>) -> Result<Option<Value>, DbErr> {
    row.map(serde_json::to_value)
        .transpose()
        .map_err(|error| DbErr::Json(error.to_string()))
}

/// The live settings row: `select … where deleted_at is null limit 1`.
async fn settings_row(db: &PgPool) -> Result<Option<Value>, DbErr> {
    let row = helpdesk_settings::Entity::find()
        .filter(helpdesk_settings::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js(row)
}

/// The first live legacy widget.
async fn first_widget(db: &PgPool) -> Result<Option<Value>, DbErr> {
    let row = widgets::Entity::find()
        .filter(widgets::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js(row)
}

async fn overview(caller: Caller) -> Response {
    let settings = settings_row(&caller.db).await;
    let widget = first_widget(&caller.db).await;
    match (settings, widget) {
        (Ok(settings), Ok(widget)) => Data(json!({
            "settings": settings,
            "widgetSettings": widget,
        }))
        .into_response(),
        (Err(error), _) | (_, Err(error)) => {
            Refusal::from(error).respond("Failed to fetch helpdesk settings")
        }
    }
}

/// Write `section` on the settings row, or create the row with it; the
/// `helpdesk_settings:updated` event carries `event_value`.
async fn save_section(
    state: &DeskState,
    caller: &Caller,
    section: &str,
    value: impl FnOnce(Option<&Value>) -> Value,
    event_value: Value,
) -> Result<(), DbErr> {
    let existing = settings_row(&caller.db).await?;
    let now = utc_now();
    let (id, section_value) = match &existing {
        Some(row) => (
            row["id"].as_str().unwrap_or_default().to_owned(),
            value(row.get(section)),
        ),
        None => (generate_id("hds"), value(None)),
    };
    let column = section_column(section);
    let db = orm(&caller.db);
    if existing.is_some() {
        helpdesk_settings::Entity::update_many()
            .col_expr(column, Expr::value(section_value))
            .col_expr(helpdesk_settings::Column::UpdatedAt, Expr::value(now))
            .filter(helpdesk_settings::Column::Id.eq(&id))
            .exec(&db)
            .await?;
    } else {
        let mut row = helpdesk_settings::ActiveModel {
            id: Set(id.clone()),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        let section_value = Set(Some(section_value));
        match column {
            helpdesk_settings::Column::Notifications => row.notifications = section_value,
            helpdesk_settings::Column::Automation => row.automation = section_value,
            helpdesk_settings::Column::Tickets => row.tickets = section_value,
            _ => row.satisfaction = section_value,
        }
        helpdesk_settings::Entity::insert(row)
            .exec_without_returning(&db)
            .await?;
    }
    let mut data = Map::new();
    data.insert(section.to_owned(), event_value);
    caller.publish(
        state,
        ev::HELPDESK_SETTINGS_UPDATED,
        &id,
        &Value::Object(data),
    );
    Ok(())
}

/// The column of one section.
fn section_column(section: &str) -> helpdesk_settings::Column {
    match section {
        "notifications" => helpdesk_settings::Column::Notifications,
        "automation" => helpdesk_settings::Column::Automation,
        "tickets" => helpdesk_settings::Column::Tickets,
        _ => helpdesk_settings::Column::Satisfaction,
    }
}

/// `{ ...existing, ...data }`: the stored section with the body's keys laid
/// over it (a missing or non-object section spreads as nothing).
fn merged(existing: Option<&Value>, data: &Map<String, Value>) -> Value {
    let mut out = match existing {
        Some(Value::Object(fields)) => fields.clone(),
        _ => Map::new(),
    };
    for (key, value) in data {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

fn ok() -> Response {
    Data(json!({ "success": true })).into_response()
}

async fn notifications(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update notification settings";
    let data = match validate(&headers, &body, |issues, fields| {
        let mut data = Map::new();
        for key in [
            "emailNotifications",
            "pushNotifications",
            "smsNotifications",
        ] {
            if let Some(flag) = issues
                .boolean(fields, key, Presence::Required)
                .into_option()
            {
                data.insert(key.to_owned(), Value::Bool(flag));
            }
        }
        for key in NOTIFY_FLAGS {
            if let Some(flag) = issues
                .boolean(fields, key, Presence::Optional)
                .into_option()
            {
                data.insert(key.to_owned(), Value::Bool(flag));
            }
        }
        data
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let mut notifs = Map::new();
    for key in [
        "emailNotifications",
        "pushNotifications",
        "smsNotifications",
    ] {
        notifs.insert(
            key.to_owned(),
            data.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    for key in NOTIFY_FLAGS {
        // `data.notifyOnNewTicket ?? true`
        notifs.insert(
            key.to_owned(),
            data.get(key).cloned().unwrap_or(Value::Bool(true)),
        );
    }
    let notifs = Value::Object(notifs);
    match save_section(
        &state,
        &caller,
        "notifications",
        |_| notifs.clone(),
        notifs.clone(),
    )
    .await
    {
        Ok(()) => ok(),
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn automation(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update automation settings";
    let data = match validate(&headers, &body, |issues, fields| {
        let mut data = Map::new();
        if let Some(flag) = issues
            .boolean(fields, "enabled", Presence::Required)
            .into_option()
        {
            data.insert("enabled".to_owned(), Value::Bool(flag));
        }
        if let Some(action) = issues
            .choice(
                fields,
                "slaBreachAction",
                Presence::Optional,
                &["escalate_and_notify", "notify_only", "none"],
            )
            .into_option()
        {
            data.insert("slaBreachAction".to_owned(), Value::String(action));
        }
        if let Some(levels) = issues
            .list(
                fields,
                "priorityAlertThreshold",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_choice(item, &["urgent", "high"]),
            )
            .into_option()
        {
            data.insert(
                "priorityAlertThreshold".to_owned(),
                Value::Array(levels.into_iter().map(Value::String).collect()),
            );
        }
        data
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let event = Value::Object(data.clone());
    // Merge: the WeldDesk inbox keeps its auto-assignment in this blob too.
    match save_section(
        &state,
        &caller,
        "automation",
        |existing| match existing {
            Some(_) => merged(existing, &data),
            None => Value::Object(data.clone()),
        },
        event,
    )
    .await
    {
        Ok(()) => ok(),
        Err(error) => Refusal::from(error).respond(message),
    }
}

/// `/tickets` and `/satisfaction`: merged into the stored section, or the
/// body itself on a new row.
async fn merged_section(
    state: DeskState,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
    section: &str,
    fields: &'static [(&'static str, Opt)],
    message: &str,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let mut data = Map::new();
        read_optional(issues, body, fields, &mut data);
        data
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let event = Value::Object(data.clone());
    match save_section(
        &state,
        &caller,
        section,
        |existing| match existing {
            Some(_) => merged(existing, &data),
            None => Value::Object(data.clone()),
        },
        event,
    )
    .await
    {
        Ok(()) => ok(),
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn tickets(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    merged_section(
        state,
        caller,
        headers,
        body,
        "tickets",
        TICKET_FIELDS,
        "Failed to update ticket settings",
    )
    .await
}

async fn satisfaction(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    merged_section(
        state,
        caller,
        headers,
        body,
        "satisfaction",
        SATISFACTION_FIELDS,
        "Failed to update satisfaction settings",
    )
    .await
}

// ── the primary widget ──────────────────────────────────────────────────────

/// Register a widget in the master `widget_registry`; errors are swallowed
/// (`catch { /* registry may already exist */ }`).
async fn register(
    caller: &Caller,
    state: &DeskState,
    workspace_id: &str,
    widget_id: &str,
    name: &str,
    now: PrimitiveDateTime,
) {
    let Some(master) = master(caller, state) else {
        return;
    };
    let inserted = widget_registry::Entity::insert(widget_registry::ActiveModel {
        id: Set(generate_id("wr")),
        widget_id: Set(widget_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        widget_name: Set(Some(name.to_owned())),
        is_active: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec_without_returning(&orm(&master))
    .await;
    if let Err(error) = inserted {
        tracing::warn!(%error, "[desk-api/helpdesk-settings] widget registry insert failed");
    }
}

/// A master `widget_registry` update by widget id: `column` set to
/// `value`; errors are swallowed.
async fn update_registry(
    caller: &Caller,
    state: &DeskState,
    widget_id: &str,
    column: widget_registry::Column,
    value: Expr,
) {
    let Some(master) = master(caller, state) else {
        return;
    };
    let updated = widget_registry::Entity::update_many()
        .col_expr(column, value)
        .col_expr(widget_registry::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(widget_registry::Column::WidgetId.eq(widget_id))
        .exec(&orm(&master))
        .await;
    if let Err(error) = updated {
        tracing::warn!(%error, "[desk-api/helpdesk-settings] widget registry update failed");
    }
}

/// The boolean page defaults every new widget starts from.
const PAGE_DEFAULTS: [(&str, bool); 9] = [
    ("pageHome", true),
    ("pageChat", true),
    ("pageHelp", true),
    ("pageParcelTracking", false),
    ("pageChangelog", true),
    ("pageNews", true),
    ("pageFeedback", true),
    ("pageAnnouncements", true),
    ("pageEventSignUp", false),
];

async fn primary_widget(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
) -> Response {
    let message = "Failed to fetch widget settings";
    let existing = match first_widget(&caller.db).await {
        Ok(row) => row,
        Err(error) => return Refusal::from(error).respond(message),
    };
    match existing {
        None => {
            let id = generate_id("wgt");
            let widget_id = generate_id("widget");
            let (now, at) = stamp();
            let mut values = Map::new();
            WIDGETS.set(&mut values, "id", json!(id));
            WIDGETS.set(&mut values, "widgetId", json!(widget_id));
            WIDGETS.set(&mut values, "widgetName", json!("Default Widget"));
            for (prop, flag) in PAGE_DEFAULTS {
                WIDGETS.set(&mut values, prop, Value::Bool(flag));
            }
            WIDGETS.set(&mut values, "autoOpen", Value::Bool(false));
            WIDGETS.set(&mut values, "showWelcomeMessage", Value::Bool(true));
            WIDGETS.set(&mut values, "createdAt", json!(now));
            WIDGETS.set(&mut values, "updatedAt", json!(now));
            let created = match WIDGETS
                .insert(&caller.db, values, &["createdAt", "updatedAt"])
                .await
            {
                Ok(row) => row,
                Err(error) => return write_failed(&error, message),
            };
            register(
                &caller,
                &state,
                &tenant.workspace_id,
                &widget_id,
                "Default Widget",
                at,
            )
            .await;
            Data(created).into_response()
        }
        Some(mut row) if row["widgetId"].as_str().is_none_or(str::is_empty) => {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let widget_id = generate_id("widget");
            let now = utc_now();
            let updated = widgets::Entity::update_many()
                .col_expr(widgets::Column::WidgetId, Expr::value(&widget_id))
                .col_expr(widgets::Column::UpdatedAt, Expr::value(now))
                .filter(widgets::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
                .await;
            if let Err(error) = updated {
                return Refusal::from(error).respond(message);
            }
            let name = row["widgetName"]
                .as_str()
                .unwrap_or("Default Widget")
                .to_owned();
            register(
                &caller,
                &state,
                &tenant.workspace_id,
                &widget_id,
                &name,
                now,
            )
            .await;
            // `{ ...widgetSettings, widgetId }`: the row as read, with the
            // new widget id laid over it.
            row["widgetId"] = json!(widget_id);
            Data(row).into_response()
        }
        Some(row) => Data(row).into_response(),
    }
}

/// `{ id, widgetId, ...data }`, the event data of a widget save.
fn widget_event(id: &Value, widget_id: &Value, data: &Map<String, Value>) -> Value {
    let mut event = Map::new();
    event.insert("id".to_owned(), id.clone());
    event.insert("widgetId".to_owned(), widget_id.clone());
    for (key, value) in data {
        event.insert(key.clone(), value.clone());
    }
    Value::Object(event)
}

async fn save_primary(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update widget settings";
    let data = match read_widget(&headers, &body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let existing = match first_widget(&caller.db).await {
        Ok(row) => row,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let (now, at) = stamp();
    if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let mut values = Map::new();
        WIDGETS.set(&mut values, "updatedAt", json!(now));
        values.extend(WIDGETS.values(&data));
        if let Err(error) = WIDGETS
            .patch(&caller.db, &id, values, false, &["updatedAt"])
            .await
        {
            return write_failed(&error, message);
        }
        caller.publish(
            &state,
            ev::HELPDESK_SETTINGS_UPDATED,
            &id,
            &widget_event(&existing["id"], &existing["widgetId"], &data),
        );
        return Data(json!({ "id": id, "widgetId": existing["widgetId"], "isNew": false }))
            .into_response();
    }
    let id = generate_id("wgt");
    let widget_id = generate_id("widget");
    let name = data
        .get("widgetName")
        .and_then(Value::as_str)
        .unwrap_or("Default Widget")
        .to_owned();
    let mut values = Map::new();
    WIDGETS.set(&mut values, "id", json!(id));
    WIDGETS.set(&mut values, "widgetId", json!(widget_id));
    WIDGETS.set(&mut values, "widgetName", json!(name));
    for (prop, flag) in PAGE_DEFAULTS {
        WIDGETS.set(&mut values, prop, Value::Bool(flag));
    }
    WIDGETS.set(&mut values, "autoOpen", Value::Bool(false));
    WIDGETS.set(&mut values, "showWelcomeMessage", Value::Bool(true));
    WIDGETS.set(&mut values, "showBranding", Value::Bool(true));
    WIDGETS.set(&mut values, "emailCollection", json!("none"));
    values.extend(WIDGETS.values(&data));
    WIDGETS.set(&mut values, "updatedAt", json!(now));
    WIDGETS.set(&mut values, "createdAt", json!(now));
    if let Err(error) = WIDGETS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    register(&caller, &state, &tenant.workspace_id, &widget_id, &name, at).await;
    caller.publish(
        &state,
        ev::HELPDESK_SETTINGS_UPDATED,
        &id,
        &widget_event(&json!(id), &json!(widget_id), &data),
    );
    Created(json!({ "id": id, "widgetId": widget_id, "isNew": true })).into_response()
}

async fn toggle_enabled(State(state): State<DeskState>, caller: Caller, body: Bytes) -> Response {
    let message = "Failed to update widget enabled status";
    // `c.req.json().catch(() => ({ enabled: false }))`; `body.enabled` of a
    // JSON null throws (the route's 500), of anything else not an object is
    // undefined.
    let enabled = match lenient_json(&body) {
        None => Some(Value::Bool(false)),
        Some(Value::Null) => {
            return ApiError::internal().with_message(message).into_response();
        }
        Some(Value::Object(fields)) => fields.get("enabled").cloned(),
        Some(_) => None,
    };
    let existing = match first_widget(&caller.db).await {
        Ok(row) => row,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let now = now();
    let event_data = |id: &str, widget_id: Option<&Value>| {
        let mut event = Map::new();
        event.insert("id".to_owned(), json!(id));
        if let Some(widget_id) = widget_id {
            event.insert("widgetId".to_owned(), widget_id.clone());
        }
        if let Some(enabled) = &enabled {
            event.insert("pageChat".to_owned(), enabled.clone());
        }
        Value::Object(event)
    };
    if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let mut values = Map::new();
        if let Some(enabled) = &enabled {
            WIDGETS.set(&mut values, "pageChat", enabled.clone());
        }
        WIDGETS.set(&mut values, "updatedAt", json!(now));
        if let Err(error) = WIDGETS
            .patch(&caller.db, &id, values, false, &["updatedAt"])
            .await
        {
            return write_failed(&error, message);
        }
        caller.publish(
            &state,
            ev::HELPDESK_SETTINGS_UPDATED,
            &id,
            &event_data(&id, None),
        );
        return Data(json!({ "id": id, "widgetId": existing["widgetId"], "isNew": false }))
            .into_response();
    }
    let id = generate_id("wgt");
    let widget_id = generate_id("widget");
    let mut values = Map::new();
    WIDGETS.set(&mut values, "id", json!(id));
    WIDGETS.set(&mut values, "widgetId", json!(widget_id));
    if let Some(enabled) = &enabled {
        WIDGETS.set(&mut values, "pageChat", enabled.clone());
    }
    WIDGETS.set(&mut values, "pageHome", Value::Bool(true));
    WIDGETS.set(&mut values, "pageHelp", Value::Bool(true));
    WIDGETS.set(&mut values, "widgetName", json!("Default Widget"));
    WIDGETS.set(&mut values, "createdAt", json!(now));
    WIDGETS.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = WIDGETS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    caller.publish(
        &state,
        ev::HELPDESK_SETTINGS_UPDATED,
        &id,
        &event_data(&id, Some(&json!(widget_id))),
    );
    Created(json!({ "id": id, "widgetId": widget_id, "isNew": true })).into_response()
}

// ── the widgets ─────────────────────────────────────────────────────────────

async fn list_widgets(caller: Caller) -> Response {
    let rows = widgets::Entity::find()
        .filter(widgets::Column::DeletedAt.is_null())
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(json!(rows)).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list widgets"),
    }
}

async fn create_widget(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to create widget";
    let data = match read_widget(&headers, &body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let id = generate_id("wgt");
    let widget_id = generate_id("widget");
    let (now, at) = stamp();
    let name = data
        .get("widgetName")
        .and_then(Value::as_str)
        .unwrap_or("New Widget")
        .to_owned();
    let mut values = Map::new();
    WIDGETS.set(&mut values, "id", json!(id));
    WIDGETS.set(&mut values, "widgetId", json!(widget_id));
    for (prop, flag) in PAGE_DEFAULTS {
        WIDGETS.set(&mut values, prop, Value::Bool(flag));
    }
    WIDGETS.set(&mut values, "autoOpen", Value::Bool(false));
    WIDGETS.set(&mut values, "showWelcomeMessage", Value::Bool(true));
    WIDGETS.set(&mut values, "showBranding", Value::Bool(true));
    WIDGETS.set(&mut values, "emailCollection", json!("none"));
    values.extend(WIDGETS.values(&data));
    WIDGETS.set(&mut values, "widgetName", json!(name));
    WIDGETS.set(&mut values, "createdAt", json!(now));
    WIDGETS.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = WIDGETS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    register(&caller, &state, &tenant.workspace_id, &widget_id, &name, at).await;
    let created = json!({ "id": id, "widgetId": widget_id, "widgetName": name });
    caller.publish(&state, ev::HELPDESK_WIDGET_CREATED, &id, &created);
    Created(created).into_response()
}

/// The live widget with this widget id.
async fn widget_by_widget_id(db: &PgPool, widget_id: &str) -> Result<Option<Value>, DbErr> {
    let row = widgets::Entity::find()
        .filter(widgets::Column::WidgetId.eq(widget_id))
        .filter(widgets::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js(row)
}

async fn widget_detail(caller: Caller, Path(widget_id): Path<String>) -> Response {
    let message = "Failed to fetch widget";
    match widget_by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn update_widget(
    State(state): State<DeskState>,
    caller: Caller,
    Path(widget_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update widget";
    let data = match read_widget(&headers, &body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let existing = match widget_by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    };
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    let mut values = Map::new();
    WIDGETS.set(&mut values, "updatedAt", json!(now()));
    values.extend(WIDGETS.values(&data));
    if let Err(error) = WIDGETS
        .patch(&caller.db, &id, values, false, &["updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    if let Some(name) = data.get("widgetName") {
        // `widgetName: data.widgetName`: the schema lets only a string through.
        let name = match name {
            Value::String(name) => Some(name.clone()),
            Value::Null => None,
            other => Some(other.to_string()),
        };
        update_registry(
            &caller,
            &state,
            &widget_id,
            widget_registry::Column::WidgetName,
            Expr::value(name),
        )
        .await;
    }
    caller.publish(
        &state,
        ev::HELPDESK_WIDGET_UPDATED,
        &id,
        &widget_event(&json!(id), &json!(widget_id), &data),
    );
    Data(json!({ "id": id, "widgetId": widget_id })).into_response()
}

async fn delete_widget(
    State(state): State<DeskState>,
    caller: Caller,
    Path(widget_id): Path<String>,
) -> Response {
    let message = "Failed to delete widget";
    let existing = match widget_by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    };
    let count = widgets::Entity::find()
        .filter(widgets::Column::DeletedAt.is_null())
        .count(&orm(&caller.db))
        .await;
    match count {
        Ok(count) if count <= 1 => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": "Cannot delete the last widget." })),
            )
                .into_response();
        }
        Ok(_) => {}
        Err(error) => return Refusal::from(error).respond(message),
    }
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    let now = utc_now();
    let deleted = widgets::Entity::update_many()
        .col_expr(widgets::Column::DeletedAt, Expr::value(now))
        .col_expr(widgets::Column::UpdatedAt, Expr::value(now))
        .filter(widgets::Column::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = deleted {
        return Refusal::from(error).respond(message);
    }
    update_registry(
        &caller,
        &state,
        &widget_id,
        widget_registry::Column::IsActive,
        Expr::value(false),
    )
    .await;
    caller.publish(
        &state,
        ev::HELPDESK_WIDGET_DELETED,
        &id,
        &json!({ "id": id, "widgetId": widget_id }),
    );
    Data(json!({ "success": true })).into_response()
}
