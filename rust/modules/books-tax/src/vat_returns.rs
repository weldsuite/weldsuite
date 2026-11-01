//! `/api/vat-returns` (`routes/vat-returns/index.ts`): the Dutch
//! BTW-aangifte (calculated → reviewed → filed → accepted / rejected), its
//! suppletie, its SBR/XBRL message, and India's GST worksheet
//! (`GET /gst-worksheet`, computed on demand, nothing stored).
//!
//! Filing goes through Digipoort as the worker does without its certificate
//! binding: a simulated submission ([`crate::filing`]).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, is_kor_active, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, now_ms, ok, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::jurisdictions::features;
use weldsuite_books_domain::tables::{ENTITIES, VAT_RETURNS};
use weldsuite_catalogs::entity_events::{
    VAT_RETURN_CREATED, VAT_RETURN_DELETED, VAT_RETURN_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::filing::{
    file_period, filing_status, is_unfiled, iso_day, load_period_lines, parse_period, submit_filing,
};
use crate::nl::{self, Rubrieken, VatXmlInput, compute_rubrieken, recompute_totals};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("reports:read")))
        .route(
            "/gst-worksheet",
            get(crate::gst::worksheet).route_layer(need("reports:read")),
        )
        .route("/{id}", get(detail).route_layer(need("reports:read")))
        .route(
            "/calculate",
            post(calculate).route_layer(need("reports:create")),
        )
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("reports:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("reports:delete")),
        )
        .route("/{id}/file", post(file).route_layer(need("reports:update")))
        .route(
            "/{id}/suppletie",
            post(suppletie).route_layer(need("reports:create")),
        )
        .route(
            "/{id}/filing-status",
            get(status).route_layer(need("reports:read")),
        )
        .route("/{id}/xml", get(xml).route_layer(need("reports:read")))
        .with_state(state)
}

/// The phone number is a mandatory part of the aangifte message.
const PHONE_REQUIRED: &str = "A telephone number is required in the BTW-aangifte message. Add it to the entity contact details first.";

/// A live return, as Drizzle returns it.
async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(vat_returns),
        " from vat_returns t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| VAT_RETURNS.js(row)))
}

/// The entity row; `live` adds `deleted_at is null`.
pub(crate) async fn entity_row(
    db: &PgPool,
    id: &str,
    live: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and ($2 = false or t.deleted_at is null) limit 1"
    ))
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ENTITIES.js(row)))
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `entityRow.taxIdentifiers?.vatNumber`, when truthy.
pub(crate) fn btw_number(entity: &Value) -> Option<String> {
    entity
        .get("taxIdentifiers")
        .and_then(|t| t.get("vatNumber"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `entityRow.legalName || entityRow.name`.
pub(crate) fn company_name(entity: &Value) -> String {
    text(entity, "legalName")
        .filter(|n| !n.is_empty())
        .or_else(|| text(entity, "name"))
        .unwrap_or_default()
        .to_owned()
}

/// `entityRow.contact?.phone || ''`.
pub(crate) fn phone(entity: &Value) -> String {
    entity
        .get("contact")
        .and_then(|c| c.get("phone"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `getJurisdictionFeatures(code)[feature]`.
pub(crate) fn has_feature(code: Option<&str>, feature: &str) -> bool {
    features(code)[feature].as_bool().unwrap_or(false)
}

/// The XBRL of a stored return.
fn vat_xml(ret: &Value, entity: &Value, btw: &str, rubrieken: &Rubrieken) -> String {
    let id = text(ret, "id").unwrap_or_default();
    let name = company_name(entity);
    nl::generate_vat_xml(&VatXmlInput {
        btw_number: btw,
        contact_name: &name,
        contact_phone: &phone(entity),
        period_start: text(ret, "periodStart").unwrap_or_default(),
        period_end: text(ret, "periodEnd").unwrap_or_default(),
        rubrieken,
        message_reference: &format!("OB-{id}"),
        now: &now(),
    })
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    reply(list_returns(&caller).await, "Failed to fetch VAT returns")
}

async fn list_returns(caller: &Caller) -> Reply {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(vat_returns),
        " from vat_returns t where t.deleted_at is null and t.entity_id = $1 \
         order by t.period_start desc"
    ))
    .bind(&entity_id)
    .fetch_all(&caller.db)
    .await?;
    Ok(ok(Value::Array(
        rows.into_iter()
            .map(|row| nl::with_normalized(VAT_RETURNS.js(row)))
            .collect(),
    )))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(ret) = find(&caller.db, &id).await? else {
                return Err(Refusal::not_found("VAT return", &id));
            };
            Ok(ok(nl::with_normalized(ret)))
        }
        .await,
        "Failed to fetch VAT return",
    )
}

// ── POST /calculate ─────────────────────────────────────────────────────────

/// The calculate body (`periodType`, `periodStart`, `periodEnd`, `periodLabel`).
pub(crate) struct PeriodBody {
    pub period_type: String,
    pub period_start: String,
    pub period_end: String,
    pub period_label: Option<String>,
}

pub(crate) fn read_period(issues: &mut Issues, body: &Map<String, Value>) -> PeriodBody {
    let period_type = issues
        .choice(
            body,
            "periodType",
            Presence::Required,
            &["monthly", "quarterly", "yearly"],
        )
        .into_option();
    let period_start = issues.text(body, "periodStart", Presence::Required, None, None);
    let period_end = issues.text(body, "periodEnd", Presence::Required, None, None);
    let period_label = issues.text(body, "periodLabel", Presence::Optional, None, None);
    PeriodBody {
        period_type: period_type.unwrap_or_default(),
        period_start: period_start.into_option().unwrap_or_default(),
        period_end: period_end.into_option().unwrap_or_default(),
        period_label: period_label.into_option(),
    }
}

async fn calculate(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_period) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to calculate VAT return"),
    };
    reply(
        calculate_return(&caller, &state, data).await,
        "Failed to calculate VAT return",
    )
}

async fn calculate_return(caller: &Caller, state: &BooksState, data: PeriodBody) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let Some(entity) = entity_row(db, &entity_id, true).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    let code = text(&entity, "jurisdictionCode");
    if !has_feature(code, "vatReturn") {
        return Err(Refusal::bad_request(
            "This entity's jurisdiction has no Dutch VAT return. Use the tax return for its own jurisdiction.",
        ));
    }
    if is_kor_active(
        code.unwrap_or_default(),
        entity.get("jurisdictionSettings"),
        now_ms(),
    ) {
        return Err(Refusal::bad_request(
            "This entity uses the kleineondernemersregeling (KOR) — no BTW-aangifte is due while KOR is active. Disable KOR in the entity settings if the exemption no longer applies.",
        ));
    }
    let (start, end) =
        parse_period(&data.period_start, &data.period_end).map_err(Refusal::bad_request)?;

    let existing: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(vat_returns),
        " from vat_returns t where t.entity_id = $1 and t.period_start = $2::timestamp \
         and t.period_end = $3::timestamp and t.correction_of_id is null and t.deleted_at is null \
         order by t.created_at desc limit 1"
    ))
    .bind(&entity_id)
    .bind(&start)
    .bind(&end)
    .fetch_optional(db)
    .await?;
    let existing = existing.map(|row| VAT_RETURNS.js(row));
    if let Some(existing) = &existing
        && !is_unfiled(text(existing, "status").unwrap_or_default())
    {
        return Err(Refusal::bad_request(
            "The BTW-aangifte of this period has already been filed. Use \"Check for corrections\" on it to file a suppletie.",
        ));
    }

    let lines = load_period_lines(db, &entity_id, &iso_day(&start), &iso_day(&end)).await?;
    let calculated = compute_rubrieken(&lines.into_iter().map(|l| l.line).collect::<Vec<_>>());
    // The manual boxes (KOR reduction, estimates) belong to the return: keep them.
    let kept = existing
        .as_ref()
        .and_then(|e| nl::normalize(e.get("rubrieken")));
    let rubrieken = match kept {
        Some(kept) => {
            let mut next = calculated;
            for key in ["r5d", "r5e", "r5f"] {
                next.set(key, kept.get(key));
            }
            recompute_totals(&next)
        }
        None => calculated,
    };

    let now = now();
    let label = data.period_label.filter(|l| !l.is_empty());
    let id = match &existing {
        Some(existing) => {
            let id = text(existing, "id").unwrap_or_default().to_owned();
            sqlx::query(
                "update vat_returns set period_type = $1, period_label = $2, status = 'calculated', \
                 rubrieken = $3, xml_content = null, rejected_at = null, rejection_reason = null, \
                 updated_at = $4::timestamp where id = $5",
            )
            .bind(&data.period_type)
            .bind(label.as_deref().or_else(|| text(existing, "periodLabel")))
            .bind(rubrieken.to_value())
            .bind(&now)
            .bind(&id)
            .execute(db)
            .await?;
            id
        }
        None => {
            let id = generate_id("vat");
            sqlx::query(
                "insert into vat_returns (id, entity_id, period_type, period_start, period_end, \
                 period_label, status, rubrieken, created_at, updated_at) \
                 values ($1, $2, $3, $4::timestamp, $5::timestamp, $6, 'calculated', $7, $8::timestamp, $8::timestamp)",
            )
            .bind(&id)
            .bind(&entity_id)
            .bind(&data.period_type)
            .bind(&start)
            .bind(&end)
            .bind(label.as_deref())
            .bind(rubrieken.to_value())
            .bind(&now)
            .execute(db)
            .await?;
            id
        }
    };

    let recalculated = existing.is_some();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "vat_return",
            entity_id: &id,
            action: if recalculated {
                "recalculated"
            } else {
                "calculated"
            },
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        if recalculated {
            VAT_RETURN_UPDATED
        } else {
            VAT_RETURN_CREATED
        },
        &id,
        json!({ "id": id, "rubrieken": rubrieken.to_value() }),
    );
    let body = json!({ "id": id, "rubrieken": rubrieken.to_value(), "recalculated": recalculated });
    Ok(if recalculated {
        ok(body)
    } else {
        created(body)
    })
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

struct PatchBody {
    rubrieken: Option<Map<String, Value>>,
    notes: Option<String>,
}

/// `z.object({ rubrieken: z.record(z.number()).optional(), notes: z.string().optional() })`.
fn read_patch(issues: &mut Issues, body: &Map<String, Value>) -> PatchBody {
    let rubrieken = issues
        .nested(body, "rubrieken", Presence::Optional, |issues, fields| {
            for key in fields.keys() {
                issues.number(fields, key, Presence::Required, Number::default());
            }
            fields.clone()
        })
        .into_option();
    let notes = issues
        .text(body, "notes", Presence::Optional, None, None)
        .into_option();
    PatchBody { rubrieken, notes }
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_patch) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update VAT return"),
    };
    reply(
        update_return(&caller, &state, &id, data).await,
        "Failed to update VAT return",
    )
}

async fn update_return(caller: &Caller, state: &BooksState, id: &str, data: PatchBody) -> Reply {
    let db = &caller.db;
    let Some(ret) = find(db, id).await? else {
        return Err(Refusal::not_found("VAT return", id));
    };
    if !is_unfiled(text(&ret, "status").unwrap_or_default()) {
        return Err(Refusal::bad_request(
            "Filed VAT returns are immutable — file a correction (suppletie) instead",
        ));
    }
    let now = now();
    let mut update = Map::new();
    update.insert("status".into(), json!("reviewed"));
    update.insert("updatedAt".into(), json!(now));
    let mut new_rubrieken: Option<Value> = None;
    if let Some(adjust) = &data.rubrieken {
        let mut adjusted = nl::normalize(ret.get("rubrieken")).unwrap_or_default();
        for key in nl::RUBRIEKEN {
            if let Some(value) = adjust.get(key).and_then(Value::as_f64)
                && value.is_finite()
            {
                adjusted.set(key, js::math_round(value * 100.0) / 100.0);
            }
        }
        let value = recompute_totals(&adjusted).to_value();
        update.insert("rubrieken".into(), value.clone());
        new_rubrieken = Some(value);
    }
    if let Some(notes) = &data.notes {
        update.insert("notes".into(), json!(notes));
    }
    sqlx::query(
        "update vat_returns set status = 'reviewed', updated_at = $1::timestamp, \
         rubrieken = case when $2 then $3 else rubrieken end, \
         notes = case when $4 then $5 else notes end where id = $6",
    )
    .bind(&now)
    .bind(new_rubrieken.is_some())
    .bind(new_rubrieken.clone())
    .bind(data.notes.is_some())
    .bind(data.notes.as_deref())
    .bind(id)
    .execute(db)
    .await?;

    let changes = new_rubrieken.as_ref().map(|value| {
        let mut changes = Map::new();
        changes.insert(
            "rubrieken".into(),
            change(
                ret.get("rubrieken").cloned().unwrap_or(Value::Null),
                value.clone(),
            ),
        );
        changes
    });
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&ret, "entityId"),
            entity_type: "vat_return",
            entity_id: id,
            action: "reviewed",
            changes,
        },
    )
    .await;
    let mut merged = ret.as_object().cloned().unwrap_or_default();
    merged.extend(update);
    let merged = Value::Object(merged);
    caller.publish(state, VAT_RETURN_UPDATED, id, merged.clone());
    Ok(ok(nl::with_normalized(merged)))
}

// ── POST /:id/file ──────────────────────────────────────────────────────────

async fn file(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    reply(
        file_return(&caller, &state, &id).await,
        "Failed to file VAT return",
    )
}

async fn file_return(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(ret) = find(db, id).await? else {
        return Err(Refusal::not_found("VAT return", id));
    };
    let Some(rubrieken) = nl::normalize(ret.get("rubrieken")) else {
        return Err(Refusal::bad_request(
            "VAT return has no calculated rubrieken",
        ));
    };
    let status = text(&ret, "status").unwrap_or_default().to_owned();
    if !is_unfiled(&status) {
        return Err(Refusal::bad_request("VAT return has already been filed"));
    }
    let entity_id = text(&ret, "entityId").unwrap_or_default().to_owned();
    let Some(entity) = entity_row(db, &entity_id, true).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    let Some(btw) = btw_number(&entity) else {
        return Err(Refusal::bad_request(
            "VAT/BTW number is not configured on this entity",
        ));
    };
    if phone(&entity).is_empty() {
        return Err(Refusal::bad_request(PHONE_REQUIRED));
    }
    let xml = vat_xml(&ret, &entity, &btw, &rubrieken);
    let submission = submit_filing(&btw, &xml, "Omzetbelasting");

    let now = now();
    let mut tx = db.begin().await?;
    sqlx::query(
        "update vat_returns set status = 'filed', rubrieken = $1, xml_content = $2, \
         filing_reference = $3, digipoort_response = $4, filed_at = $5::timestamp, filed_by = $6, \
         updated_at = $5::timestamp where id = $7",
    )
    .bind(rubrieken.to_value())
    .bind(&xml)
    .bind(Some(&submission.kenmerk).filter(|k| !k.is_empty()))
    .bind(&submission.stored)
    .bind(&now)
    .bind(caller.user())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    // A suppletie corrects an already-stamped period; only regular returns stamp rows.
    if text(&ret, "correctionOfId").is_none() {
        file_period(
            &mut tx,
            &entity_id,
            &iso_day(text(&ret, "periodStart").unwrap_or_default()),
            &iso_day(text(&ret, "periodEnd").unwrap_or_default()),
            id,
            text(&entity, "taxLockDate"),
        )
        .await?;
    }
    tx.commit().await?;

    let mut changes = Map::new();
    changes.insert("status".into(), change(json!(status), json!("filed")));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "vat_return",
            entity_id: id,
            action: "filed",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        VAT_RETURN_UPDATED,
        id,
        json!({ "id": id, "status": "filed" }),
    );
    Ok(ok(json!({
        "id": id,
        "status": "filed",
        "kenmerk": submission.kenmerk,
        "digipoortSuccess": true,
        "message": "BTW-aangifte submitted to Digipoort",
    })))
}

// ── POST /:id/suppletie ─────────────────────────────────────────────────────

async fn suppletie(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        create_suppletie(&caller, &state, &id).await,
        "Failed to create suppletie",
    )
}

async fn create_suppletie(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(original) = find(db, id).await? else {
        return Err(Refusal::not_found("VAT return", id));
    };
    if is_unfiled(text(&original, "status").unwrap_or_default()) {
        return Err(Refusal::bad_request(
            "Suppletie only applies to filed returns — unfiled returns can simply be recalculated",
        ));
    }
    if original.get("rubrieken").is_none_or(Value::is_null) {
        return Err(Refusal::bad_request("Original return has no rubrieken"));
    }
    let entity_id = text(&original, "entityId").unwrap_or_default().to_owned();
    let start = text(&original, "periodStart")
        .unwrap_or_default()
        .to_owned();
    let end = text(&original, "periodEnd").unwrap_or_default().to_owned();
    let lines = load_period_lines(db, &entity_id, &iso_day(&start), &iso_day(&end)).await?;
    let recalculated = compute_rubrieken(&lines.into_iter().map(|l| l.line).collect::<Vec<_>>());
    let filed = nl::normalize(original.get("rubrieken")).unwrap_or_default();
    let net_diff = js::math_round((recalculated.get("r5g") - filed.get("r5g")) * 100.0) / 100.0;

    if net_diff == 0.0 {
        return Ok(ok(json!({
            "correctionRequired": false,
            "netDiff": 0,
            "message": "The ledger matches the filed return — no suppletie needed.",
        })));
    }
    let diff_text = js::to_fixed(net_diff, 2);
    if net_diff.abs() <= 1000.0 {
        return Ok(ok(json!({
            "correctionRequired": false,
            "foldIntoNextReturn": true,
            "netDiff": js::number_value(net_diff),
            "recalculated": recalculated.to_value(),
            "message": format!("Net correction of €{diff_text} is within the €1,000 threshold — it may be folded into the next regular BTW-aangifte instead of a separate suppletie."),
        })));
    }

    let now_millis = now_ms();
    let now = js::iso_from_millis(now_millis).unwrap_or_else(now);
    let deadline = js::iso_from_millis(now_millis + 8 * 7 * 24 * 3600 * 1000).unwrap_or_default();
    let deadline_day = iso_day(&deadline);
    let suppletie_id = generate_id("vat");
    let label = text(&original, "periodLabel").filter(|l| !l.is_empty());
    let period_label = label.map_or_else(|| "Suppletie".to_owned(), |l| format!("{l} (suppletie)"));
    let of = text(&original, "periodLabel").unwrap_or(id);
    let notes = format!(
        "Suppletie of {of}: net difference €{diff_text} vs the filed return. Must be filed by {deadline_day} (8 weeks after discovery)."
    );
    sqlx::query(
        "insert into vat_returns (id, entity_id, period_type, period_start, period_end, period_label, \
         status, rubrieken, correction_of_id, suppletie_deadline, notes, created_at, updated_at) \
         values ($1, $2, $3, $4::timestamp, $5::timestamp, $6, 'calculated', $7, $8, $9::timestamp, $10, \
         $11::timestamp, $11::timestamp)",
    )
    .bind(&suppletie_id)
    .bind(&entity_id)
    .bind(text(&original, "periodType"))
    .bind(&start)
    .bind(&end)
    .bind(&period_label)
    .bind(recalculated.to_value())
    .bind(id)
    .bind(&deadline)
    .bind(&notes)
    .bind(&now)
    .execute(db)
    .await?;

    let mut changes = Map::new();
    changes.insert(
        "netDiff".into(),
        change(json!(0), js::number_value(net_diff)),
    );
    changes.insert("correctionOfId".into(), change(Value::Null, json!(id)));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "vat_return",
            entity_id: &suppletie_id,
            action: "suppletie_created",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        VAT_RETURN_CREATED,
        &suppletie_id,
        json!({ "id": suppletie_id, "correctionOfId": id, "netDiff": js::number_value(net_diff) }),
    );
    Ok(created(json!({
        "correctionRequired": true,
        "id": suppletie_id,
        "netDiff": js::number_value(net_diff),
        "recalculated": recalculated.to_value(),
        "suppletieDeadline": deadline,
        "message": format!("Suppletie created — net correction €{diff_text} exceeds the €1,000 threshold. File it via Digipoort before {deadline_day}."),
    })))
}

// ── GET /:id/filing-status ──────────────────────────────────────────────────

async fn status(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(ret) = find(&caller.db, &id).await? else {
                return Err(Refusal::not_found("VAT return", &id));
            };
            let Some(reference) = text(&ret, "filingReference").filter(|r| !r.is_empty()) else {
                return Err(Refusal::bad_request("VAT return has not been filed yet"));
            };
            // The simulated status is `submitted`: nothing to persist.
            let mut body = Map::new();
            body.insert("id".into(), json!(id));
            body.insert("kenmerk".into(), json!(reference));
            if let Value::Object(result) = filing_status() {
                body.extend(result);
            }
            Ok(ok(Value::Object(body)))
        }
        .await,
        "Failed to check filing status",
    )
}

// ── GET /:id/xml ────────────────────────────────────────────────────────────

async fn xml(caller: Caller, Path(id): Path<String>) -> Response {
    reply(download(&caller, &id).await, "Failed to get XML")
}

async fn download(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(ret) = find(db, id).await? else {
        return Err(Refusal::not_found("VAT return", id));
    };
    let xml = match text(&ret, "xmlContent").filter(|x| !x.is_empty()) {
        Some(xml) => xml.to_owned(),
        None => {
            let Some(rubrieken) = nl::normalize(ret.get("rubrieken")) else {
                return Err(Refusal::bad_request(
                    "VAT return has no calculated rubrieken",
                ));
            };
            let entity_id = text(&ret, "entityId").unwrap_or_default();
            let entity = entity_row(db, entity_id, true).await?;
            let btw = entity.as_ref().and_then(btw_number);
            let (Some(entity), Some(btw)) = (entity, btw) else {
                return Err(Refusal::bad_request(
                    "VAT/BTW number is not configured on this entity",
                ));
            };
            vat_xml(&ret, &entity, &btw, &rubrieken)
        }
    };
    let label = text(&ret, "periodLabel")
        .filter(|l| !l.is_empty())
        .unwrap_or(id);
    Ok(xml_response(xml, &format!("btw-aangifte-{label}.xml")))
}

/// `new Response(xml, { headers: { Content-Type, Content-Disposition } })`.
pub(crate) fn xml_response(xml: String, filename: &str) -> Response {
    let mut response = (StatusCode::OK, xml).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let Some(ret) = find(db, &id).await? else {
                return Err(Refusal::not_found("VAT return", &id));
            };
            let status = text(&ret, "status").unwrap_or_default().to_owned();
            if !is_unfiled(&status) {
                return Err(Refusal::bad_request(
                    "A filed VAT return can not be deleted — correct it with a suppletie instead",
                ));
            }
            let now = now();
            sqlx::query(
                "update vat_returns set deleted_at = $1::timestamp, updated_at = $1::timestamp \
                 where id = $2 and status <> 'filed'",
            )
            .bind(&now)
            .bind(&id)
            .execute(db)
            .await?;
            let mut changes = Map::new();
            changes.insert("status".into(), change(json!(status), json!("deleted")));
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: text(&ret, "entityId"),
                    entity_type: "vat_return",
                    entity_id: &id,
                    action: "deleted",
                    changes: Some(changes),
                },
            )
            .await;
            caller.publish(&state, VAT_RETURN_DELETED, &id, json!({ "id": id }));
            Ok(no_content())
        }
        .await,
        "Failed to delete VAT return",
    )
}
