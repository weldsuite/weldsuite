//! `/api/sales-tax-rules` (`routes/sales-tax-rules/index.ts`): the manual
//! engine's taxability rules. Per agency and tax code: taxable or not, from
//! when, on what share of the price, for which use, at what combined rate.
//! Rules of one agency, code and use never overlap in time.

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
use weldsuite_books_domain::sales_tax::errors::SalesTaxError;
use weldsuite_books_domain::sales_tax::route_helpers::{
    check_date_order, optional_sales_tax_entity, page_params, ranges_overlap, require_agency,
    require_sales_tax_entity,
};
use weldsuite_books_domain::sales_tax::tax_codes::{
    is_avalara_tax_code, is_stripe_tax_code, is_weld_tax_code,
};
use weldsuite_books_domain::tables::SALES_TAX_TAXABILITY_RULES as T;
use weldsuite_catalogs::entity_events::{
    SALES_TAX_RULE_CREATED, SALES_TAX_RULE_DELETED, SALES_TAX_RULE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{
    changes, fixed4, iso_date, keep, merged, num, number_of, percent, percent_refined, refuse, text,
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
        .with_state(state)
}

struct RuleBody {
    agency_id: Field<String>,
    tax_code: Field<String>,
    taxable: Field<bool>,
    taxable_percent: Field<f64>,
    applies_to_use: Field<String>,
    rate_override: Field<f64>,
    effective_from: Field<String>,
    effective_to: Field<String>,
    notes: Field<String>,
}

fn known_code(code: &str) -> bool {
    is_weld_tax_code(code) || is_stripe_tax_code(code) || is_avalara_tax_code(code)
}

fn read_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> RuleBody {
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
    let tax_code = issues.text(body, "taxCode", required, Some(1), Some(30));
    // `.refine()` runs on a string that got past its type check, even when
    // its length failed.
    let code_refine = body
        .get("taxCode")
        .and_then(Value::as_str)
        .is_some_and(|code| !known_code(code));
    let taxable = issues.boolean(body, "taxable", required);
    let (taxable_percent, percent_failed) =
        percent(issues, body, "taxablePercent", Presence::Optional);
    let applies_to_use = issues.choice(
        body,
        "appliesToUse",
        Presence::Optional,
        &["any", "business", "personal"],
    );
    let (rate_override, override_failed) = percent(issues, body, "rateOverride", Presence::Nullish);
    let effective_from = iso_date(issues, body, "effectiveFrom", required);
    let effective_to = iso_date(issues, body, "effectiveTo", Presence::Nullish);
    let notes = issues.text(body, "notes", Presence::Nullish, None, Some(2000));
    if code_refine {
        issues.custom(
            "taxCode",
            "Use a WeldBooks tax code (general, saas, shipping, ...)",
        );
    }
    percent_refined(issues, "taxablePercent", percent_failed);
    percent_refined(issues, "rateOverride", override_failed);
    RuleBody {
        agency_id,
        tax_code: if code_refine { Field::Absent } else { tax_code },
        taxable,
        taxable_percent,
        applies_to_use,
        rate_override,
        effective_from,
        effective_to,
        notes,
    }
}

async fn require_rule(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_taxability_rules),
        " from sales_tax_taxability_rules t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| T.js(r))
        .ok_or_else(|| refuse(format!("Sales tax rule {id} not found"), 404))
}

/// Another rule of the same agency, code and use covering any of the same days.
#[allow(clippy::too_many_arguments)]
async fn assert_no_overlap(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
    tax_code: &str,
    applies_to_use: &str,
    from: &str,
    to: Option<&str>,
    ignore: Option<&str>,
) -> Result<(), Refusal> {
    let existing: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, effective_from::text, effective_to::text from sales_tax_taxability_rules \
         where entity_id = $1 and agency_id = $2 and tax_code = $3 and applies_to_use = $4 and deleted_at is null",
    )
    .bind(entity_id)
    .bind(agency_id)
    .bind(tax_code)
    .bind(applies_to_use)
    .fetch_all(db)
    .await?;
    let clash = existing.iter().find(|(id, f, t)| {
        Some(id.as_str()) != ignore
            && ranges_overlap((f, t.as_deref()), (from, to.filter(|t| !t.is_empty())))
    });
    if let Some((_, f, t)) = clash {
        let until = t
            .as_deref()
            .map_or_else(|| " onward".to_owned(), |t| format!(" to {t}"));
        return Err(refuse(
            format!(
                "A rule for {tax_code} already applies from {f}{until}. End it before adding one that overlaps."
            ),
            409,
        ));
    }
    Ok(())
}

fn event_data(rule: &Value) -> Value {
    json!({
        "id": rule["id"],
        "agencyId": rule["agencyId"],
        "taxCode": rule["taxCode"],
        "taxable": rule["taxable"],
        "taxablePercent": num(number_of(&rule["taxablePercent"])),
        "effectiveFrom": rule["effectiveFrom"],
        "effectiveTo": rule["effectiveTo"],
    })
}

#[allow(clippy::needless_pass_by_value, reason = "used as map_err(setup)")]
fn setup(error: SalesTaxError) -> Refusal {
    Refusal::Response(Box::new(error.response()))
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
            entity_type: "sales_tax_rule",
            entity_id: id,
            action,
            changes,
        },
    )
    .await;
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_rules(&caller, &q).await,
        "Failed to fetch sales tax rules",
    )
}

async fn list_rules(caller: &Caller, q: &Query) -> Reply {
    let Some(entity) = optional_sales_tax_entity(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let entity_id = text(&entity, "id").unwrap_or_default();
    let (page, page_size, offset) = page_params(q);
    let agency = q.present("agencyId");
    let code = q.present("taxCode");
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_taxability_rules),
        " from sales_tax_taxability_rules t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.tax_code = $3) \
         order by t.agency_id asc, t.tax_code asc, t.effective_from asc limit $4 offset $5"
    ))
    .bind(entity_id)
    .bind(agency)
    .bind(code)
    .bind(page_size)
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from sales_tax_taxability_rules t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.tax_code = $3)",
    )
    .bind(entity_id)
    .bind(agency)
    .bind(code)
    .fetch_one(&caller.db)
    .await?;
    Ok(paged(
        T.js_rows(rows),
        total,
        page * page_size < total,
        None,
    ))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let entity = require_sales_tax_entity(&caller).await?;
            let rule =
                require_rule(&caller.db, text(&entity, "id").unwrap_or_default(), &id).await?;
            Ok(ok(rule))
        }
        .await,
        "Failed to fetch sales tax rule",
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
        Err(refusal) => return refusal.respond("Failed to create sales tax rule"),
    };
    reply(
        create_rule(&caller, &state, data).await,
        "Failed to create sales tax rule",
    )
}

async fn create_rule(caller: &Caller, state: &BooksState, data: RuleBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let agency = require_agency(
        &caller.db,
        &entity_id,
        data.agency_id.as_set().map_or("", String::as_str),
    )
    .await?;
    let agency_id = text(&agency, "id").unwrap_or_default().to_owned();
    let from = data.effective_from.as_set().cloned().unwrap_or_default();
    let to = data.effective_to.as_set().cloned();
    check_date_order(&from, to.as_deref(), "the rule").map_err(setup)?;
    let applies = data
        .applies_to_use
        .as_set()
        .cloned()
        .unwrap_or_else(|| "any".to_owned());
    let tax_code = data.tax_code.as_set().cloned().unwrap_or_default();
    assert_no_overlap(
        &caller.db,
        &entity_id,
        &agency_id,
        &tax_code,
        &applies,
        &from,
        to.as_deref(),
        None,
    )
    .await?;
    let at = now();
    let id = generate_id("str");
    let rule = json!({
        "id": id,
        "entityId": entity_id,
        "agencyId": agency_id,
        "taxCode": tax_code,
        "taxable": data.taxable.as_set().copied().unwrap_or(false),
        "taxablePercent": fixed4(data.taxable_percent.as_set().copied().unwrap_or(100.0)),
        "appliesToUse": applies,
        "rateOverride": data.rate_override.as_set().map(|r| fixed4(*r)),
        "effectiveFrom": from,
        "effectiveTo": to,
        "notes": data.notes.as_set(),
        "createdAt": at,
        "updatedAt": at,
    });
    T.insert_raw(
        &caller.db,
        T.values(rule.as_object().unwrap_or(&Map::new())),
    )
    .await?;
    audit(caller, &entity_id, &id, "created", None).await;
    caller.publish(state, SALES_TAX_RULE_CREATED, &id, event_data(&rule));
    Ok(created(rule))
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
        Err(refusal) => return refusal.respond("Failed to update sales tax rule"),
    };
    reply(
        update_rule(&caller, &state, &id, data).await,
        "Failed to update sales tax rule",
    )
}

async fn update_rule(caller: &Caller, state: &BooksState, id: &str, data: RuleBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let rule = require_rule(&caller.db, &entity_id, id).await?;
    let or_row = |field: &Field<String>, key: &str| {
        field
            .as_set()
            .cloned()
            .unwrap_or_else(|| text(&rule, key).unwrap_or("").to_owned())
    };
    let tax_code = or_row(&data.tax_code, "taxCode");
    let applies = or_row(&data.applies_to_use, "appliesToUse");
    let from = or_row(&data.effective_from, "effectiveFrom");
    let to = match &data.effective_to {
        Field::Absent => text(&rule, "effectiveTo").map(str::to_owned),
        Field::Null => None,
        Field::Set(to) => Some(to.clone()),
    };
    check_date_order(&from, to.as_deref(), "the rule").map_err(setup)?;
    assert_no_overlap(
        &caller.db,
        &entity_id,
        text(&rule, "agencyId").unwrap_or(""),
        &tax_code,
        &applies,
        &from,
        to.as_deref(),
        Some(id),
    )
    .await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    keep(&mut update, "taxCode", &data.tax_code);
    keep(&mut update, "taxable", &data.taxable);
    if let Field::Set(p) = data.taxable_percent {
        update.insert("taxablePercent".into(), json!(fixed4(p)));
    }
    keep(&mut update, "appliesToUse", &data.applies_to_use);
    match data.rate_override {
        Field::Set(r) => {
            update.insert("rateOverride".into(), json!(fixed4(r)));
        }
        Field::Null => {
            update.insert("rateOverride".into(), Value::Null);
        }
        Field::Absent => {}
    }
    keep(&mut update, "effectiveFrom", &data.effective_from);
    keep(&mut update, "effectiveTo", &data.effective_to);
    keep(&mut update, "notes", &data.notes);
    T.patch_raw(&caller.db, id, T.values(&update), false)
        .await?;
    audit(
        caller,
        &entity_id,
        id,
        "updated",
        Some(changes(&update, &rule)),
    )
    .await;
    let updated = merged(&rule, &update);
    caller.publish(state, SALES_TAX_RULE_UPDATED, id, event_data(&updated));
    Ok(ok(updated))
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
            let rule = require_rule(&caller.db, &entity_id, &id).await?;
            sqlx::query(
                "update sales_tax_taxability_rules set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
            )
            .bind(now())
            .bind(&id)
            .execute(&caller.db)
            .await?;
            audit(&caller, &entity_id, &id, "deleted", None).await;
            caller.publish(&state, SALES_TAX_RULE_DELETED, &id, event_data(&rule));
            Ok(no_content())
        }
        .await,
        "Failed to delete sales tax rule",
    )
}
