//! `/api/tax-rates` (`routes/tax-rates/index.ts`,
//! `services/accounting-tax-rate-ensure.ts`): an entity's tax rates. The list
//! brings a Dutch entity's seeded rates up to the current template first; a
//! rate on a booking can only be deactivated.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::sea_query::{Alias, Expr};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_books_domain::entity_context::{entity_exists, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::jurisdictions::{self, nl};
use weldsuite_books_domain::tables::TAX_RATES as T;
use weldsuite_catalogs::entity_events::{TAX_RATE_CREATED, TAX_RATE_DELETED, TAX_RATE_UPDATED};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::tax_rates::{self, Column};
use weldsuite_schema::tenant::{entities, journal_lines};

use crate::orm_bridge::to_json;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("settings:read")))
        .route("/", post(create).route_layer(need("settings:create")))
        .route("/{id}", get(detail).route_layer(need("settings:read")))
        .route(
            "/{id}",
            axum::routing::patch(update)
                .put(update)
                .route_layer(need("settings:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("settings:delete")),
        )
        .with_state(state)
}

const TYPES: [&str; 3] = ["sales", "purchase", "both"];

fn keep<T: serde::Serialize>(out: &mut Map<String, Value>, key: &str, field: Field<T>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// Whether a value would stop Zod's parse of the object (a wrong type, a
/// value outside an enum or a union): the object refinement then never runs.
fn aborts(body: &Map<String, Value>) -> bool {
    let not = |key: &str, ok: fn(&Value) -> bool| body.get(key).is_some_and(|v| !ok(v));
    let string = |v: &Value| v.is_string();
    // A required field left out is an `invalid_type` too.
    let missing = |key: &str| body.get(key).is_none_or(Value::is_null);
    missing("entityId")
        || missing("name")
        || missing("rate")
        || not("entityId", string)
        || not("jurisdictionCode", string)
        || not("jurisdiction", string)
        || not("name", string)
        || not("rate", |v| v.is_string() || v.is_number())
        || not("type", |v| v.as_str().is_some_and(|t| TYPES.contains(&t)))
        || not("taxCategoryCode", string)
        || not("isDefault", Value::is_boolean)
        || not("isActive", Value::is_boolean)
        || not("description", string)
        || not("ledgerAccountId", string)
        || not("jurisdictionMetadata", Value::is_object)
}

/// `taxRateBaseSchema` (`.partial()` for an update; the create adds a
/// refinement): Zod's output, in the schema's order. `rate` becomes
/// `String(rate)`.
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    keep(
        &mut out,
        "entityId",
        issues.text(body, "entityId", required, Some(1), Some(30)),
    );
    keep(
        &mut out,
        "jurisdictionCode",
        issues.text(
            body,
            "jurisdictionCode",
            Presence::Optional,
            Some(2),
            Some(5),
        ),
    );
    keep(
        &mut out,
        "jurisdiction",
        issues.text(body, "jurisdiction", Presence::Optional, Some(2), Some(5)),
    );
    keep(
        &mut out,
        "name",
        issues.text(body, "name", required, Some(1), Some(100)),
    );
    if let Field::Set(rate) = issues.string_or_number(body, "rate", required) {
        let text = match rate {
            Value::Number(n) => {
                weldsuite_books_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN))
            }
            Value::String(s) => s,
            other => other.to_string(),
        };
        out.insert("rate".to_owned(), json!(text));
    }
    match issues.choice(body, "type", Presence::Optional, &TYPES) {
        Field::Set(t) => {
            out.insert("type".to_owned(), json!(t));
        }
        _ if !partial && !body.contains_key("type") => {
            out.insert("type".to_owned(), json!("both"));
        }
        _ => {}
    }
    keep(
        &mut out,
        "taxCategoryCode",
        issues.text(body, "taxCategoryCode", Presence::Optional, None, Some(30)),
    );
    keep(
        &mut out,
        "isDefault",
        issues.boolean(body, "isDefault", Presence::Optional),
    );
    keep(
        &mut out,
        "isActive",
        issues.boolean(body, "isActive", Presence::Optional),
    );
    keep(
        &mut out,
        "description",
        issues.text(body, "description", Presence::Optional, None, None),
    );
    keep(
        &mut out,
        "ledgerAccountId",
        issues.text(body, "ledgerAccountId", Presence::Optional, None, Some(30)),
    );
    let meta = issues.nested(body, "jurisdictionMetadata", Presence::Optional, |_, m| {
        m.clone()
    });
    keep(&mut out, "jurisdictionMetadata", meta);
    if !partial && !aborts(body) {
        let given = |key: &str| {
            body.get(key)
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
        };
        if !given("jurisdictionCode") && !given("jurisdiction") {
            issues.custom("jurisdictionCode", "jurisdictionCode is required");
        }
    }
    out
}

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    tax_rates::Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()
}

/// One of `ensureStandardTaxRates`' updates of the rate `id`: the `name`,
/// `rate` (text, cast to `numeric` as before) and `jurisdictionMetadata` in
/// `set`, with `updated_at`.
async fn update_standard_rate(
    db: &PgPool,
    entity_id: &str,
    id: &str,
    set: &Map<String, Value>,
    at: time::PrimitiveDateTime,
) -> Result<(), DbErr> {
    let mut update = tax_rates::Entity::update_many();
    if let Some(name) = set.get("name") {
        // `$1::jsonb ->> 'name'`
        update = update.col_expr(Column::Name, Expr::value(json_text(name)));
    }
    if let Some(rate) = set.get("rate") {
        // `($1::jsonb ->> 'rate')::numeric`
        let rate = Expr::val(json_text(rate));
        update = update.col_expr(
            Column::Rate,
            sea_orm::ExprTrait::cast_as(rate, Alias::new("numeric")),
        );
    }
    if let Some(metadata) = set.get("jurisdictionMetadata") {
        update = update.col_expr(Column::JurisdictionMetadata, Expr::value(metadata.clone()));
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(id))
        .filter(Column::EntityId.eq(entity_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `jsonb ->> key` of a value: a string as itself, `null` as SQL NULL,
/// anything else as its JSON text.
fn json_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

// ── ensureStandardTaxRates ──────────────────────────────────────────────────

/// `ensureStandardTaxRates(db, entityId)`: a Dutch entity seeded before the
/// current template gets its new rates (ICL goederen), the renamed services
/// rate, box 1b for the reduced rate and 21% on the domestic reverse charge.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn ensure_standard_tax_rates(db: &PgPool, entity_id: &str) -> Result<(), DbErr> {
    let code: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::JurisdictionCode)
        .filter(entities::Column::Id.eq(entity_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    if code.as_deref() != Some("NL") {
        return Ok(());
    }
    let rates = tax_rates::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(to_json)
        .collect::<Result<Vec<_>, _>>()?;
    let has_name = |name: &str| rates.iter().any(|r| r["name"].as_str() == Some(name));
    // An entity created without defaults has none of the standard rates.
    if !has_name("BTW Hoog 21%") {
        return Ok(());
    }
    let mut updates: Vec<(String, Map<String, Value>)> = Vec::new();
    for rate in &rates {
        let id = rate["id"].as_str().unwrap_or_default().to_owned();
        let category = rate["taxCategoryCode"].as_str();
        let meta = rate["jurisdictionMetadata"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if rate["name"].as_str() == Some(nl::legacy_eu_rate_name())
            && category == Some("eu_b2b_service")
            && !has_name(nl::eu_services_rate_name())
        {
            let mut set = Map::new();
            set.insert("name".to_owned(), json!(nl::eu_services_rate_name()));
            updates.push((id.clone(), set));
        }
        if category == Some("reduced")
            && meta.get("btwRubriek").and_then(Value::as_str) == Some("1c")
        {
            let mut next = meta.clone();
            next.insert("btwRubriek".to_owned(), json!("1b"));
            let mut set = Map::new();
            set.insert("jurisdictionMetadata".to_owned(), Value::Object(next));
            updates.push((id.clone(), set));
        }
        #[allow(clippy::float_cmp)]
        if rate["name"].as_str() == Some("BTW Verlegd")
            && category == Some("reverse_charge")
            && weldsuite_books_domain::js::numeric(&rate["rate"]) == 0.0
        {
            let mut set = Map::new();
            set.insert("rate".to_owned(), json!("21.0000"));
            updates.push((id.clone(), set));
        }
    }
    // `new Date()`: the text the new rate's row carries and the `timestamp`
    // the updates write, the same instant.
    let instant = OffsetDateTime::now_utc();
    let at = weldsuite_events::iso_timestamp(instant);
    let stamp = weldsuite_db::utc_timestamp(instant);
    for (id, set) in updates {
        update_standard_rate(db, entity_id, &id, &set, stamp).await?;
    }
    if !rates
        .iter()
        .any(|r| r["taxCategoryCode"].as_str() == Some("eu_b2b_goods"))
        && let Some(template) = jurisdictions::tax_categories("NL", None, None)
            .iter()
            .find(|t| t["name"].as_str() == Some(nl::icl_goods_rate_name()))
    {
        let mut row = Map::new();
        for (key, value) in [
            ("id", json!(generate_id("txr"))),
            ("entityId", json!(entity_id)),
            ("jurisdictionCode", json!("NL")),
            ("name", template["name"].clone()),
            ("rate", template["rate"].clone()),
            ("type", template["type"].clone()),
            ("taxCategoryCode", template["taxCategoryCode"].clone()),
            (
                "isDefault",
                json!(template["isDefault"].as_bool().unwrap_or(false)),
            ),
            (
                "isActive",
                json!(template["isActive"].as_bool().unwrap_or(true)),
            ),
            ("createdAt", json!(at)),
            ("updatedAt", json!(at)),
        ] {
            row.insert(key.to_owned(), value);
        }
        if let Some(meta) = template.get("jurisdictionMetadata") {
            row.insert("jurisdictionMetadata".to_owned(), meta.clone());
        }
        T.insert_raw(db, T.values(&row)).await?;
    }
    Ok(())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        if let Err(error) = ensure_standard_tax_rates(&caller.db, &entity_id).await {
            tracing::warn!(%error, "[books-api/tax-rates] ensureStandardTaxRates failed");
        }
        let mut filters = Condition::all()
            .add(Column::DeletedAt.is_null())
            .add(Column::EntityId.eq(entity_id.as_str()));
        if let Some(kind) = q.present("type") {
            filters = filters.add(Column::Type.eq(kind));
        }
        if let Some(active) = q.get("isActive").map(|v| v == "true") {
            filters = filters.add(Column::IsActive.eq(active));
        }
        let rows = tax_rates::Entity::find()
            .filter(filters)
            .order_by_asc(Column::Name)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(to_json)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ok(Value::Array(rows)))
    }
    .await;
    reply(result, "Failed to list tax rates")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Tax rate", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch tax rate")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create tax rate"),
    };
    reply(
        create_rate(&caller, &state, data).await,
        "Failed to create tax rate",
    )
}

async fn create_rate(caller: &Caller, state: &BooksState, data: Map<String, Value>) -> Reply {
    let db = &caller.db;
    let entity_id = data["entityId"].as_str().unwrap_or_default().to_owned();
    if !entity_exists(db, &entity_id).await? {
        return Err(Refusal::bad_request(format!(
            "Accounting entity {entity_id} does not exist in this workspace."
        )));
    }
    let code = data
        .get("jurisdictionCode")
        .and_then(Value::as_str)
        .or_else(|| data.get("jurisdiction").and_then(Value::as_str))
        .unwrap_or_default()
        .to_uppercase();
    let at = now();
    // `{ id, ...rest, jurisdictionCode, isActive, createdAt, updatedAt }`
    let mut rate = Map::new();
    rate.insert("id".to_owned(), json!(generate_id("txr")));
    for (key, value) in &data {
        if key != "jurisdiction" {
            rate.insert(key.clone(), value.clone());
        }
    }
    rate.insert("jurisdictionCode".to_owned(), json!(code));
    rate.insert(
        "isActive".to_owned(),
        json!(
            data.get("isActive")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    rate.insert("createdAt".to_owned(), json!(at));
    rate.insert("updatedAt".to_owned(), json!(at));
    T.insert_raw(db, T.values(&rate)).await?;
    let id = rate["id"].as_str().unwrap_or_default().to_owned();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "tax_rate",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(state, TAX_RATE_CREATED, &id, Value::Object(rate.clone()));
    Ok(created(Value::Object(rate)))
}

// ── PUT|PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update tax rate"),
    };
    reply(
        update_rate(&caller, &state, &id, data).await,
        "Failed to update tax rate",
    )
}

async fn update_rate(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let Some(existing) = find(caller, id).await? else {
        return Err(Refusal::not_found("Tax rate", id));
    };
    let mut set = data.clone();
    if let Some(code) = set
        .get("jurisdictionCode")
        .and_then(Value::as_str)
        .map(str::to_uppercase)
    {
        set.insert("jurisdictionCode".to_owned(), json!(code));
    }
    set.insert("updatedAt".to_owned(), json!(now()));
    T.patch_raw(db, id, T.values(&set), false).await?;
    let changes: Map<String, Value> = data
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                change(
                    existing.get(key).cloned().unwrap_or(Value::Null),
                    value.clone(),
                ),
            )
        })
        .collect();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: existing["entityId"].as_str(),
            entity_type: "tax_rate",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for (key, value) in data {
        merged.insert(key, value);
    }
    caller.publish(state, TAX_RATE_UPDATED, id, Value::Object(merged.clone()));
    Ok(ok(Value::Object(merged)))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Tax rate", &id));
        };
        let used = journal_lines::Entity::find()
            .filter(journal_lines::Column::TaxRateId.eq(id.as_str()))
            .filter(journal_lines::Column::DeletedAt.is_null())
            .count(&orm(db))
            .await?;
        if used > 0 {
            return Err(Refusal::bad_request(
                "Tax rate is used by bookings — deactivate it instead",
            ));
        }
        let at = weldsuite_db::utc_now();
        tax_rates::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: existing["entityId"].as_str(),
                entity_type: "tax_rate",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, TAX_RATE_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete tax rate")
}
