//! `/api/sales-tax-zones` (`routes/sales-tax-zones/index.ts`): the manual
//! engine's tax zones, the jurisdictions that apply together to a ZIP code
//! or range (`is_origin`: the entity's own location). A zone's
//! jurisdictions all belong to its agency.

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
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_books_domain::sales_tax::route_helpers::{
    optional_sales_tax_entity, page_params, require_agency, require_sales_tax_entity,
};
use weldsuite_books_domain::tables::SALES_TAX_ZONES as T;
use weldsuite_catalogs::entity_events::{
    SALES_TAX_ZONE_CREATED, SALES_TAX_ZONE_DELETED, SALES_TAX_ZONE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{changes, keep, merged, num, number_of, refuse, text, today};

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
        .with_state(state)
}

fn is_zip5(text: &str) -> bool {
    text.len() == 5 && text.bytes().all(|b| b.is_ascii_digit())
}

const ZIP_MESSAGE: &str = "A ZIP code is five digits";

struct ZoneBody {
    agency_id: Field<String>,
    name: Field<String>,
    jurisdiction_ids: Field<Vec<String>>,
    postal_codes: Field<Vec<Value>>,
    is_origin: Field<bool>,
    priority: Field<i64>,
}

/// `postalCodeSchema`: a ZIP, or `{ from, to }` of ZIPs.
fn read_postal_code(issues: &mut Issues, item: &Value) -> Option<Value> {
    // A union returns the first option that is only dirty (the right type,
    // a failed check) with its own issues; only when every option fails its
    // type is it an `invalid_union`.
    let regex =
        || json!({ "validation": "regex", "code": "invalid_string", "message": ZIP_MESSAGE });
    match item {
        Value::String(zip) if is_zip5(zip) => Some(item.clone()),
        Value::String(_) => {
            issues.issue_here(regex());
            None
        }
        Value::Object(range) => {
            let from = range.get("from").and_then(Value::as_str);
            let to = range.get("to").and_then(Value::as_str);
            let (Some(f), Some(t)) = (from, to) else {
                union_issue(issues, item);
                return None;
            };
            let mut ok = true;
            for (key, zip) in [("from", f), ("to", t)] {
                if !is_zip5(zip) {
                    issues.push_issue(key, regex());
                    ok = false;
                }
            }
            ok.then(|| json!({ "from": f, "to": t }))
        }
        _ => {
            union_issue(issues, item);
            None
        }
    }
}

/// Zod's `invalid_union` of `z.union([zip5, z.object({ from: zip5, to: zip5 })])`.
fn union_issue(issues: &mut Issues, item: &Value) {
    let path = issues.path_here();
    let string_errors = match item {
        Value::String(_) => json!([{
            "validation": "regex",
            "code": "invalid_string",
            "message": ZIP_MESSAGE,
            "path": path,
        }]),
        other => json!([{
            "code": "invalid_type",
            "expected": "string",
            "received": type_name(other),
            "path": path,
            "message": format!("Expected string, received {}", type_name(other)),
        }]),
    };
    let object_errors = match item {
        Value::Object(range) => {
            let mut list = Vec::new();
            for key in ["from", "to"] {
                let mut key_path = path.as_array().cloned().unwrap_or_default();
                key_path.push(json!(key));
                match range.get(key) {
                    Some(Value::String(zip)) if is_zip5(zip) => {}
                    Some(Value::String(_)) => list.push(json!({
                        "validation": "regex",
                        "code": "invalid_string",
                        "message": ZIP_MESSAGE,
                        "path": key_path,
                    })),
                    other => {
                        let received = other.map_or("undefined", type_name);
                        list.push(json!({
                            "code": "invalid_type",
                            "expected": "string",
                            "received": received,
                            "path": key_path,
                            "message": if received == "undefined" { "Required".to_owned() } else { format!("Expected string, received {received}") },
                        }));
                    }
                }
            }
            Value::Array(list)
        }
        other => json!([{
            "code": "invalid_type",
            "expected": "object",
            "received": type_name(other),
            "path": path,
            "message": format!("Expected object, received {}", type_name(other)),
        }]),
    };
    issues.issue_here(json!({
        "code": "invalid_union",
        "unionErrors": [
            { "issues": string_errors, "name": "ZodError" },
            { "issues": object_errors, "name": "ZodError" },
        ],
        "message": "Invalid input",
    }));
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn read_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> ZoneBody {
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
    let name = issues.text(body, "name", required, Some(1), Some(255));
    let jurisdiction_ids = issues.list(
        body,
        "jurisdictionIds",
        required,
        Some(1),
        None,
        |i, item| {
            i.item_text(
                item,
                weldsuite_kit::validation::Text::length(Some(1), Some(30)),
            )
        },
    );
    let postal_codes = issues.list(
        body,
        "postalCodes",
        Presence::Optional,
        None,
        Some(5000),
        read_postal_code,
    );
    let is_origin = issues.boolean(body, "isOrigin", Presence::Optional);
    let priority = issues.whole_number(
        body,
        "priority",
        Presence::Optional,
        weldsuite_kit::validation::Number {
            min: Some(0.0),
            max: Some(10000.0),
            ..Default::default()
        },
    );
    ZoneBody {
        agency_id,
        name,
        jurisdiction_ids,
        postal_codes,
        is_origin,
        priority,
    }
}

/// ZIP ranges run low to high.
fn check_ranges(codes: Option<&Vec<Value>>) -> Result<(), Refusal> {
    for code in codes.into_iter().flatten() {
        if let (Some(from), Some(to)) = (text(code, "from"), text(code, "to"))
            && from > to
        {
            return Err(refuse(
                format!("The ZIP range {from}-{to} runs backwards"),
                400,
            ));
        }
    }
    Ok(())
}

/// `[...new Set(ids)]`.
fn unique(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// The zone's jurisdictions must be live jurisdictions of its own agency.
async fn check_jurisdictions(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
    ids: &[String],
) -> Result<(), Refusal> {
    let unique = unique(ids);
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select id, agency_id from sales_tax_jurisdictions where entity_id = $1 and id = any($2) and deleted_at is null",
    )
    .bind(entity_id)
    .bind(&unique)
    .fetch_all(db)
    .await?;
    let agency_of = |id: &str| rows.iter().find(|(r, _)| r == id).map(|(_, a)| a.as_str());
    let missing: Vec<&str> = unique
        .iter()
        .map(String::as_str)
        .filter(|id| agency_of(id).is_none())
        .collect();
    if !missing.is_empty() {
        return Err(refuse(
            format!("Jurisdiction {} does not exist", missing.join(", ")),
            400,
        ));
    }
    let foreign: Vec<&str> = unique
        .iter()
        .map(String::as_str)
        .filter(|id| agency_of(id) != Some(agency_id))
        .collect();
    if !foreign.is_empty() {
        return Err(refuse(
            format!(
                "A zone can only combine jurisdictions of its own agency (state). {} belong{} to another one.",
                foreign.join(", "),
                if foreign.len() > 1 { "" } else { "s" }
            ),
            400,
        ));
    }
    Ok(())
}

/// `id, name, level` of a jurisdiction.
type Triple = (String, String, String);
/// `effective_from, effective_to (or empty), jurisdiction_id, rate` of a rate.
type Quad = (String, String, String, String);

/// `presentZones(db, entityId, zones)`: each zone with its jurisdictions'
/// names, levels and the combined rate in force today.
async fn present_zones(
    db: &PgPool,
    entity_id: &str,
    zones: Vec<Value>,
    day: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for zone in &zones {
        for id in zone["jurisdictionIds"].as_array().into_iter().flatten() {
            if let Some(id) = id.as_str()
                && !ids.iter().any(|x| x == id)
            {
                ids.push(id.to_owned());
            }
        }
    }
    let (jurisdictions, rates): (Vec<Triple>, Vec<Quad>) = if ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let jurisdictions = sqlx::query_as(
                "select id, name, level from sales_tax_jurisdictions where entity_id = $1 and id = any($2)",
            )
            .bind(entity_id)
            .bind(&ids)
            .fetch_all(db)
            .await?;
        let rates = sqlx::query_as(
                "select effective_from::text, coalesce(effective_to::text, ''), jurisdiction_id, rate::text                  from sales_tax_jurisdiction_rates where entity_id = $1 and jurisdiction_id = any($2) and deleted_at is null",
            )
            .bind(entity_id)
            .bind(&ids)
            .fetch_all(db)
            .await?;
        (jurisdictions, rates)
    };
    let day = day.to_owned();
    // A `Map`: the last rate in force read wins.
    let mut current: Vec<(String, f64)> = Vec::new();
    for (from, to, jurisdiction, rate) in &rates {
        if from.as_str() <= day.as_str() && (to.is_empty() || to.as_str() >= day.as_str()) {
            let jurisdiction = jurisdiction.clone();
            let value = number_of(&json!(rate));
            match current.iter_mut().find(|(j, _)| *j == jurisdiction) {
                Some(slot) => slot.1 = value,
                None => current.push((jurisdiction, value)),
            }
        }
    }
    Ok(zones
        .into_iter()
        .map(|zone| {
            let parts: Vec<Value> = zone["jurisdictionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| {
                    let rate = current
                        .iter()
                        .find(|(j, _)| j == id)
                        .map_or(Value::Null, |(_, r)| num(*r));
                    match jurisdictions.iter().find(|(j, _, _)| j == id) {
                        Some((j, name, level)) => {
                            json!({ "id": j, "name": name, "level": level, "currentRate": rate })
                        }
                        None => json!({ "id": id, "name": id, "level": "district", "currentRate": rate }),
                    }
                })
                .filter(|p| p["name"].as_str().is_some_and(|n| !n.is_empty()))
                .collect();
            let sum = parts
                .iter()
                .fold(0.0, |s, p| s + p["currentRate"].as_f64().unwrap_or(0.0));
            let combined = weldsuite_books_domain::js::math_round(sum * 10000.0) / 10000.0;
            let mut out = zone.as_object().cloned().unwrap_or_default();
            out.insert("jurisdictions".into(), Value::Array(parts));
            out.insert("combinedRate".into(), num(combined));
            Value::Object(out)
        })
        .collect())
}

async fn require_zone(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_zones),
        " from sales_tax_zones t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| T.js(r))
        .ok_or_else(|| refuse(format!("Sales tax zone {id} not found"), 404))
}

fn event_data(zone: &Value) -> Value {
    json!({
        "id": zone["id"],
        "agencyId": zone["agencyId"],
        "stateCode": zone["stateCode"],
        "name": zone["name"],
        "isOrigin": zone["isOrigin"],
    })
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
            entity_type: "sales_tax_zone",
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
        list_zones(&caller, &state, &q).await,
        "Failed to fetch sales tax zones",
    )
}

async fn list_zones(caller: &Caller, state: &BooksState, q: &Query) -> Reply {
    let Some(entity) = optional_sales_tax_entity(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let entity_id = text(&entity, "id").unwrap_or_default();
    let (page, page_size, offset) = page_params(q);
    let agency = q.present("agencyId");
    let state_code = q.present("stateCode").map(str::to_uppercase);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_zones),
        " from sales_tax_zones t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.state_code = $3) \
         order by t.state_code asc, t.priority asc, t.name asc limit $4 offset $5"
    ))
    .bind(entity_id)
    .bind(agency)
    .bind(&state_code)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from sales_tax_zones t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.state_code = $3)",
    )
    .bind(entity_id)
    .bind(agency)
    .bind(&state_code)
    .fetch_one(&caller.db)
    .await?;
    let rows = present_zones(
        &caller.db,
        entity_id,
        T.js_rows(rows),
        &today(caller, state),
    )
    .await?;
    Ok(paged(rows, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let entity = require_sales_tax_entity(&caller).await?;
            let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
            let zone = require_zone(&caller.db, &entity_id, &id).await?;
            Ok(ok(present_zones(
                &caller.db,
                &entity_id,
                vec![zone],
                &today(&caller, &state),
            )
            .await?
            .remove(0)))
        }
        .await,
        "Failed to fetch sales tax zone",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_body(i, b, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create sales tax zone"),
    };
    reply(
        create_zone(&caller, &state, data).await,
        "Failed to create sales tax zone",
    )
}

async fn create_zone(caller: &Caller, state: &BooksState, data: ZoneBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let agency = require_agency(
        &caller.db,
        &entity_id,
        data.agency_id.as_set().map_or("", String::as_str),
    )
    .await?;
    let agency_id = text(&agency, "id").unwrap_or_default().to_owned();
    check_ranges(data.postal_codes.as_set())?;
    let ids = data.jurisdiction_ids.as_set().cloned().unwrap_or_default();
    check_jurisdictions(&caller.db, &entity_id, &agency_id, &ids).await?;
    let at = now();
    let id = generate_id("stz");
    let zone = json!({
        "id": id,
        "entityId": entity_id,
        "agencyId": agency_id,
        "stateCode": agency["stateCode"],
        "name": js_trim(data.name.as_set().map_or("", String::as_str)),
        "jurisdictionIds": unique(&ids),
        "postalCodes": data.postal_codes.as_set().cloned().unwrap_or_default(),
        "isOrigin": data.is_origin.as_set().copied().unwrap_or(false),
        "priority": data.priority.as_set().copied().unwrap_or(100),
        "createdAt": at,
        "updatedAt": at,
    });
    T.insert_raw(
        &caller.db,
        T.values(zone.as_object().unwrap_or(&Map::new())),
    )
    .await?;
    audit(caller, &entity_id, &id, "created", None).await;
    caller.publish(state, SALES_TAX_ZONE_CREATED, &id, event_data(&zone));
    let row = present_zones(&caller.db, &entity_id, vec![zone], &today(caller, state))
        .await?
        .remove(0);
    Ok(created(row))
}

// ── PUT/PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |i, b| read_body(i, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update sales tax zone"),
    };
    reply(
        update_zone(&caller, &state, &id, data).await,
        "Failed to update sales tax zone",
    )
}

async fn update_zone(caller: &Caller, state: &BooksState, id: &str, data: ZoneBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let zone = require_zone(&caller.db, &entity_id, id).await?;
    check_ranges(data.postal_codes.as_set())?;
    if let Field::Set(ids) = &data.jurisdiction_ids {
        check_jurisdictions(
            &caller.db,
            &entity_id,
            text(&zone, "agencyId").unwrap_or(""),
            ids,
        )
        .await?;
    }
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    if let Field::Set(name) = &data.name {
        update.insert("name".into(), json!(js_trim(name)));
    }
    if let Field::Set(ids) = &data.jurisdiction_ids {
        update.insert("jurisdictionIds".into(), json!(unique(ids)));
    }
    keep(&mut update, "postalCodes", &data.postal_codes);
    keep(&mut update, "isOrigin", &data.is_origin);
    keep(&mut update, "priority", &data.priority);
    T.patch_raw(&caller.db, id, T.values(&update), false)
        .await?;
    audit(
        caller,
        &entity_id,
        id,
        "updated",
        Some(changes(&update, &zone)),
    )
    .await;
    let updated = merged(&zone, &update);
    caller.publish(state, SALES_TAX_ZONE_UPDATED, id, event_data(&updated));
    let row = present_zones(&caller.db, &entity_id, vec![updated], &today(caller, state))
        .await?
        .remove(0);
    Ok(ok(row))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let entity = require_sales_tax_entity(&caller).await?;
            let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
            let zone = require_zone(&caller.db, &entity_id, &id).await?;
            sqlx::query(
                "update sales_tax_zones set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
            )
            .bind(now())
            .bind(&id)
            .execute(&caller.db)
            .await?;
            audit(&caller, &entity_id, &id, "deleted", None).await;
            caller.publish(&state, SALES_TAX_ZONE_DELETED, &id, event_data(&zone));
            Ok(no_content())
        }
        .await,
        "Failed to delete sales tax zone",
    )
}
