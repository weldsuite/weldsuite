//! `/api/sales-tax-jurisdictions` (`routes/sales-tax-jurisdictions/index.ts`):
//! the manual engine's taxing jurisdictions (state, county, city, special
//! district) and their dated rates. A rate is picked by the document's tax
//! point, never today, so rates only ever get new rows with new dates: the
//! ranges of one jurisdiction never overlap.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, all_rows, created, no_content, now, ok, paged,
    reply, validate,
};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_books_domain::sales_tax::route_helpers::{
    check_date_order, day_before, optional_sales_tax_entity, page_params, ranges_overlap,
    require_agency, require_sales_tax_entity,
};
use weldsuite_books_domain::tables::{
    SALES_TAX_JURISDICTION_RATES as R, SALES_TAX_JURISDICTIONS as T,
};
use weldsuite_catalogs::entity_events::{
    SALES_TAX_JURISDICTION_CREATED, SALES_TAX_JURISDICTION_DELETED, SALES_TAX_JURISDICTION_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{
    changes, fixed4, iso_date, keep, merged, num, number_of, percent, percent_refined, refuse,
    text, today,
};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("taxes:read")))
        .route("/", post(create).route_layer(need("taxes:create")))
        .route("/{id}", get(detail).route_layer(need("taxes:read")))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need("taxes:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("taxes:delete")),
        )
        .route(
            "/{id}/rates",
            get(list_rates).route_layer(need("taxes:read")),
        )
        .route(
            "/{id}/rates",
            post(add_rate).route_layer(need("taxes:create")),
        )
        .route(
            "/{id}/rates/{rate_id}",
            axum::routing::patch(update_rate).route_layer(need("taxes:update")),
        )
        .route(
            "/{id}/rates/{rate_id}",
            axum::routing::delete(delete_rate).route_layer(need("taxes:delete")),
        )
        .with_state(state)
}

const LEVELS: [&str; 4] = ["state", "county", "city", "district"];

/// `rateBodySchema` read: rate, from, to (and whether the rate's refinement
/// failed).
struct RateBody {
    rate: Field<f64>,
    effective_from: Field<String>,
    effective_to: Field<String>,
    close_previous: Field<bool>,
}

fn read_rate(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
    close: bool,
) -> RateBody {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let (rate, refine) = percent(issues, body, "rate", required);
    let effective_from = iso_date(issues, body, "effectiveFrom", required);
    let effective_to = iso_date(issues, body, "effectiveTo", Presence::Nullish);
    let close_previous = if close {
        issues.boolean(body, "closePrevious", Presence::Optional)
    } else {
        Field::Absent
    };
    percent_refined(issues, "rate", refine);
    RateBody {
        rate,
        effective_from,
        effective_to,
        close_previous,
    }
}

struct JurisdictionBody {
    agency_id: Field<String>,
    level: Field<String>,
    name: Field<String>,
    code: Field<String>,
    reporting_code: Field<String>,
    is_active: Field<bool>,
    rate: Field<RateBody>,
}

fn read_jurisdiction(
    issues: &mut Issues,
    body: &Map<String, Value>,
    update: bool,
) -> JurisdictionBody {
    let required = if update {
        Presence::Optional
    } else {
        Presence::Required
    };
    let agency_id = if update {
        Field::Absent
    } else {
        issues.text(body, "agencyId", Presence::Required, Some(1), Some(30))
    };
    let level = issues.choice(body, "level", required, &LEVELS);
    let name = issues.text(body, "name", required, Some(1), Some(255));
    let code = issues.text(body, "code", Presence::Nullish, None, Some(30));
    let reporting_code = issues.text(body, "reportingCode", Presence::Nullish, None, Some(30));
    let is_active = issues.boolean(body, "isActive", Presence::Optional);
    let rate = if update {
        Field::Absent
    } else {
        issues.nested(body, "rate", Presence::Optional, |i, b| {
            read_rate(i, b, false, false)
        })
    };
    JurisdictionBody {
        agency_id,
        level,
        name,
        code,
        reporting_code,
        is_active,
        rate,
    }
}

/// The rate in force on a day (the latest start wins).
fn rate_on<'a>(rates: &'a [Value], day: &str) -> Option<&'a Value> {
    let mut found: Vec<&Value> = rates
        .iter()
        .filter(|r| {
            text(r, "effectiveFrom").is_some_and(|f| f <= day)
                && text(r, "effectiveTo").is_none_or(|t| t.is_empty() || t >= day)
        })
        .collect();
    // `(a.effectiveFrom < b.effectiveFrom ? 1 : -1)`: later first, ties keep
    // the second's order.
    found.sort_by(|a, b| {
        if text(a, "effectiveFrom") < text(b, "effectiveFrom") {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        }
    });
    found.first().copied()
}

/// The rates of jurisdictions, newest first.
async fn load_rates(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_jurisdiction_rates),
        " from sales_tax_jurisdiction_rates t where t.entity_id = $1 and t.jurisdiction_id = any($2) \
         and t.deleted_at is null order by t.effective_from desc"
    ))
    .bind(entity_id)
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(R.js_rows(rows))
}

fn rates_of(rates: &[Value], id: &str) -> Vec<Value> {
    rates
        .iter()
        .filter(|r| text(r, "jurisdictionId") == Some(id))
        .cloned()
        .collect()
}

/// `present(row, rates)`: the jurisdiction with its rate in force today.
fn present(row: &Value, rates: Vec<Value>, day: &str) -> Value {
    let current = rate_on(&rates, day).map_or(Value::Null, |r| num(number_of(&r["rate"])));
    let mut out = row.as_object().cloned().unwrap_or_default();
    out.insert("currentRate".into(), current);
    out.insert("rates".into(), Value::Array(rates));
    Value::Object(out)
}

async fn require_jurisdiction(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_jurisdictions),
        " from sales_tax_jurisdictions t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| T.js(r))
        .ok_or_else(|| refuse(format!("Sales tax jurisdiction {id} not found"), 404))
}

/// No two rates of a jurisdiction cover the same day.
fn assert_no_overlap(
    existing: &[Value],
    from: &str,
    to: Option<&str>,
    ignore: Option<&str>,
) -> Result<(), Refusal> {
    let clash = existing.iter().find(|r| {
        text(r, "id") != ignore
            && ranges_overlap(
                (
                    text(r, "effectiveFrom").unwrap_or(""),
                    text(r, "effectiveTo").filter(|t| !t.is_empty()),
                ),
                (from, to.filter(|t| !t.is_empty())),
            )
    });
    if let Some(clash) = clash {
        let to = text(clash, "effectiveTo")
            .filter(|t| !t.is_empty())
            .map_or_else(|| " onward".to_owned(), |t| format!(" to {t}"));
        return Err(refuse(
            format!(
                "This rate overlaps the {}% rate that applies from {}{to}. End that rate first, or use closePrevious.",
                weldsuite_books_domain::js::number_text(number_of(&clash["rate"])),
                text(clash, "effectiveFrom").unwrap_or("")
            ),
            409,
        ));
    }
    Ok(())
}

fn event_data(row: &Value, current_rate: Option<f64>) -> Value {
    json!({
        "id": row["id"],
        "agencyId": row["agencyId"],
        "stateCode": row["stateCode"],
        "level": row["level"],
        "name": row["name"],
        "currentRate": current_rate.map_or(Value::Null, num),
    })
}

fn entity_id_of(entity: &Value) -> String {
    text(entity, "id").unwrap_or_default().to_owned()
}

async fn audit(
    caller: &Caller,
    entity_id: &str,
    id: &str,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(entity_id),
            entity_type: "sales_tax_jurisdiction",
            entity_id: id,
            action,
            changes,
        },
    )
    .await;
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_all(&caller, &state, &q).await,
        "Failed to fetch sales tax jurisdictions",
    )
}

async fn list_all(caller: &Caller, state: &BooksState, q: &Query) -> Reply {
    let day = today(caller, state);
    let Some(entity) = optional_sales_tax_entity(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let entity_id = entity_id_of(&entity);
    let (page, page_size, offset) = page_params(q);
    let agency = q.present("agencyId");
    let state = q.present("stateCode").map(str::to_uppercase);
    let level = q.present("level");
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_jurisdictions),
        " from sales_tax_jurisdictions t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.state_code = $3) \
         and ($4::text is null or t.level = $4) \
         order by t.state_code asc, t.level asc, t.name asc limit $5 offset $6"
    ))
    .bind(&entity_id)
    .bind(agency)
    .bind(&state)
    .bind(level)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from sales_tax_jurisdictions t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.state_code = $3) \
         and ($4::text is null or t.level = $4)",
    )
    .bind(&entity_id)
    .bind(agency)
    .bind(&state)
    .bind(level)
    .fetch_one(&caller.db)
    .await?;
    let rows = T.js_rows(rows);
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let rates = load_rates(&caller.db, &entity_id, &ids).await?;
    let out = rows
        .iter()
        .map(|row| present(row, rates_of(&rates, text(row, "id").unwrap_or("")), &day))
        .collect();
    Ok(paged(out, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        show(&caller, &state, &id).await,
        "Failed to fetch sales tax jurisdiction",
    )
}

async fn show(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let rates = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    Ok(ok(present(&row, rates, &today(caller, state))))
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_jurisdiction(i, b, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create sales tax jurisdiction"),
    };
    reply(
        create_jurisdiction(&caller, &state, data).await,
        "Failed to create sales tax jurisdiction",
    )
}

async fn create_jurisdiction(caller: &Caller, state: &BooksState, data: JurisdictionBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let agency_id = data.agency_id.as_set().cloned().unwrap_or_default();
    let agency = require_agency(&caller.db, &entity_id, &agency_id).await?;
    if let Field::Set(rate) = &data.rate {
        check_date_order(
            rate.effective_from.as_set().map_or("", String::as_str),
            rate.effective_to.as_set().map(String::as_str),
            "the rate",
        )
        .map_err(|e| Refusal::Response(Box::new(e.response())))?;
    }
    let at = now();
    let id = generate_id("stj");
    let jurisdiction = json!({
        "id": id,
        "entityId": entity_id,
        "agencyId": agency["id"],
        "stateCode": agency["stateCode"],
        "level": data.level.as_set(),
        "code": data.code.as_set(),
        "name": js_trim(data.name.as_set().map_or("", String::as_str)),
        "reportingCode": data.reporting_code.as_set(),
        "isActive": data.is_active.as_set().copied().unwrap_or(true),
        "createdAt": at,
        "updatedAt": at,
    });
    let rate = match &data.rate {
        Field::Set(rate) => Some(json!({
            "id": generate_id("stjr"),
            "entityId": entity_id,
            "jurisdictionId": id,
            "rate": fixed4(rate.rate.as_set().copied().unwrap_or(0.0)),
            "effectiveFrom": rate.effective_from.as_set(),
            "effectiveTo": rate.effective_to.as_set(),
            "createdAt": at,
            "updatedAt": at,
        })),
        _ => None,
    };
    let empty = Map::new();
    let mut tx = caller.db.begin().await?;
    T.insert_raw(
        &mut *tx,
        T.values(jurisdiction.as_object().unwrap_or(&empty)),
    )
    .await?;
    if let Some(rate) = &rate {
        R.insert_raw(&mut *tx, R.values(rate.as_object().unwrap_or(&empty)))
            .await?;
    }
    tx.commit().await?;
    audit(caller, &entity_id, &id, "created", None).await;
    let first = rate.as_ref().map(|r| number_of(&r["rate"]));
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_CREATED,
        &id,
        event_data(&jurisdiction, first),
    );
    Ok(created(present(
        &jurisdiction,
        rate.into_iter().collect(),
        &today(caller, state),
    )))
}

// ── PUT/PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_jurisdiction(i, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update sales tax jurisdiction"),
    };
    reply(
        update_jurisdiction(&caller, &state, &id, data).await,
        "Failed to update sales tax jurisdiction",
    )
}

async fn update_jurisdiction(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: JurisdictionBody,
) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    keep(&mut update, "level", &data.level);
    if let Field::Set(name) = &data.name {
        update.insert("name".into(), json!(js_trim(name)));
    }
    keep(&mut update, "code", &data.code);
    keep(&mut update, "reportingCode", &data.reporting_code);
    keep(&mut update, "isActive", &data.is_active);
    T.patch_raw(&caller.db, id, T.values(&update), false)
        .await?;
    audit(
        caller,
        &entity_id,
        id,
        "updated",
        Some(changes(&update, &row)),
    )
    .await;
    let updated = merged(&row, &update);
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_UPDATED,
        id,
        event_data(&updated, None),
    );
    let rates = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    Ok(ok(present(&updated, rates, &today(caller, state))))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        delete_jurisdiction(&caller, &state, &id).await,
        "Failed to delete sales tax jurisdiction",
    )
}

async fn delete_jurisdiction(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let zones: Vec<(String, Value)> = sqlx::query_as(
        "select name, jurisdiction_ids from sales_tax_zones where agency_id = $1 and deleted_at is null",
    )
    .bind(text(&row, "agencyId"))
    .fetch_all(&caller.db)
    .await?;
    let using: Vec<&String> = zones
        .iter()
        .filter(|(_, ids)| {
            ids.as_array()
                .is_some_and(|ids| ids.iter().any(|i| i.as_str() == Some(id)))
        })
        .map(|(name, _)| name)
        .collect();
    if !using.is_empty() {
        let plural = using.len() > 1;
        return Err(refuse(
            format!(
                "This jurisdiction is part of the tax zone{} {}. Remove it from {} first.",
                if plural { "s" } else { "" },
                using
                    .iter()
                    .map(|n| format!("\"{n}\""))
                    .collect::<Vec<_>>()
                    .join(", "),
                if plural { "them" } else { "it" }
            ),
            409,
        ));
    }
    let at = now();
    let mut tx = caller.db.begin().await?;
    sqlx::query("update sales_tax_jurisdiction_rates set deleted_at = $1::timestamp where jurisdiction_id = $2")
        .bind(&at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "update sales_tax_jurisdictions set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
    )
    .bind(&at)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    audit(caller, &entity_id, id, "deleted", None).await;
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_DELETED,
        id,
        event_data(&row, None),
    );
    Ok(no_content())
}

// ── Rates ───────────────────────────────────────────────────────────────────

async fn list_rates(caller: Caller, Path(id): Path<String>) -> Response {
    reply(rates_list(&caller, &id).await, "Failed to fetch rates")
}

async fn rates_list(caller: &Caller, id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    require_jurisdiction(&caller.db, &entity_id, id).await?;
    let rates = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    Ok(all_rows(rates))
}

async fn add_rate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_rate(i, b, false, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to add rate"),
    };
    reply(
        rate_create(&caller, &state, &id, data).await,
        "Failed to add rate",
    )
}

#[allow(clippy::needless_pass_by_value, reason = "used as map_err(setup)")]
fn setup(error: weldsuite_books_domain::sales_tax::errors::SalesTaxError) -> Refusal {
    Refusal::Response(Box::new(error.response()))
}

async fn rate_create(caller: &Caller, state: &BooksState, id: &str, data: RateBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let from = data.effective_from.as_set().cloned().unwrap_or_default();
    let to = data.effective_to.as_set().cloned();
    check_date_order(&from, to.as_deref(), "the rate").map_err(setup)?;
    let existing = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    let mut closing: Vec<(String, String)> = Vec::new();
    if data.close_previous.as_set() == Some(&true)
        && let Some(open) = existing.iter().find(|r| {
            text(r, "effectiveTo").is_none_or(str::is_empty)
                && text(r, "effectiveFrom").is_some_and(|f| f < from.as_str())
        })
    {
        closing.push((
            text(open, "id").unwrap_or_default().to_owned(),
            day_before(&from).unwrap_or_default(),
        ));
    }
    let mut candidates: Vec<Value> = existing
        .iter()
        .filter(|r| {
            !closing
                .iter()
                .any(|(c, _)| Some(c.as_str()) == text(r, "id"))
        })
        .cloned()
        .collect();
    for (closed_id, until) in &closing {
        if let Some(open) = existing
            .iter()
            .find(|r| text(r, "id") == Some(closed_id.as_str()))
        {
            let mut copy = open.clone();
            copy["effectiveTo"] = json!(until);
            candidates.push(copy);
        }
    }
    assert_no_overlap(&candidates, &from, to.as_deref(), None)?;
    let at = now();
    let rate_value = data.rate.as_set().copied().unwrap_or(0.0);
    let rate = json!({
        "id": generate_id("stjr"),
        "entityId": entity_id,
        "jurisdictionId": id,
        "rate": fixed4(rate_value),
        "effectiveFrom": from,
        "effectiveTo": to,
        "createdAt": at,
        "updatedAt": at,
    });
    let mut tx = caller.db.begin().await?;
    for (closed_id, until) in &closing {
        sqlx::query(
            "update sales_tax_jurisdiction_rates set effective_to = $1::date, updated_at = $2::timestamp where id = $3",
        )
        .bind(until)
        .bind(&at)
        .bind(closed_id)
        .execute(&mut *tx)
        .await?;
    }
    R.insert_raw(&mut *tx, R.values(rate.as_object().unwrap_or(&Map::new())))
        .await?;
    tx.commit().await?;
    let mut audit_changes = Map::new();
    audit_changes.insert("rate".into(), json!({ "old": null, "new": rate["rate"] }));
    audit_changes.insert(
        "effectiveFrom".into(),
        json!({ "old": null, "new": rate["effectiveFrom"] }),
    );
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_jurisdiction",
            entity_id: id,
            action: "rate_added",
            changes: Some(audit_changes),
        },
    )
    .await;
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_UPDATED,
        id,
        event_data(&row, Some(rate_value)),
    );
    Ok(created(rate))
}

async fn update_rate(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, rate_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_rate(i, b, true, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update rate"),
    };
    reply(
        rate_update(&caller, &state, &id, &rate_id, data).await,
        "Failed to update rate",
    )
}

async fn rate_update(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    rate_id: &str,
    data: RateBody,
) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let existing = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    let Some(rate) = existing
        .iter()
        .find(|r| text(r, "id") == Some(rate_id))
        .cloned()
    else {
        return Err(refuse(format!("Rate {rate_id} not found"), 404));
    };
    let from = data
        .effective_from
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&rate, "effectiveFrom").unwrap_or("").to_owned());
    let to = match &data.effective_to {
        Field::Absent => text(&rate, "effectiveTo").map(str::to_owned),
        Field::Null => None,
        Field::Set(to) => Some(to.clone()),
    };
    check_date_order(&from, to.as_deref(), "the rate").map_err(setup)?;
    assert_no_overlap(&existing, &from, to.as_deref(), Some(rate_id))?;
    let mut update = Map::new();
    if let Field::Set(value) = data.rate {
        update.insert("rate".into(), json!(fixed4(value)));
    }
    update.insert("effectiveFrom".into(), json!(from));
    update.insert("effectiveTo".into(), json!(to));
    update.insert("updatedAt".into(), json!(now()));
    R.patch_raw(&caller.db, rate_id, R.values(&update), false)
        .await?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_jurisdiction",
            entity_id: id,
            action: "rate_updated",
            changes: Some(changes(&update, &rate)),
        },
    )
    .await;
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_UPDATED,
        id,
        event_data(&row, None),
    );
    Ok(ok(merged(&rate, &update)))
}

async fn delete_rate(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, rate_id)): Path<(String, String)>,
) -> Response {
    reply(
        rate_delete(&caller, &state, &id, &rate_id).await,
        "Failed to delete rate",
    )
}

async fn rate_delete(caller: &Caller, state: &BooksState, id: &str, rate_id: &str) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = entity_id_of(&entity);
    let row = require_jurisdiction(&caller.db, &entity_id, id).await?;
    let existing = load_rates(&caller.db, &entity_id, &[id.to_owned()]).await?;
    let Some(rate) = existing.iter().find(|r| text(r, "id") == Some(rate_id)) else {
        return Err(refuse(format!("Rate {rate_id} not found"), 404));
    };
    let at = now();
    sqlx::query(
        "update sales_tax_jurisdiction_rates set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
    )
    .bind(&at)
    .bind(rate_id)
    .execute(&caller.db)
    .await?;
    let mut audit_changes = Map::new();
    audit_changes.insert("rate".into(), json!({ "old": rate["rate"], "new": null }));
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "sales_tax_jurisdiction",
            entity_id: id,
            action: "rate_deleted",
            changes: Some(audit_changes),
        },
    )
    .await;
    caller.publish(
        state,
        SALES_TAX_JURISDICTION_UPDATED,
        id,
        event_data(&row, None),
    );
    Ok(no_content())
}
