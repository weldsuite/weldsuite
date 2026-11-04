//! `/api/exemption-certificates` (`routes/exemption-certificates/index.ts`,
//! `services/sales-tax/certificate-cure.ts`): the exemption certificates
//! customers gave the entity. The status is worked out on every read: a
//! certificate is `expired` once its own expiry date, or the state's rule
//! for certificates without one, has passed in every state it covers. A
//! certificate recorded within 90 days of an exempt sale cures it.

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
use weldsuite_books_domain::jurisdictions::{js_trim, us};
use weldsuite_books_domain::sales_tax::exemptions::certificate_expiry;
use weldsuite_books_domain::sales_tax::load::to_certificate_ref;
use weldsuite_books_domain::sales_tax::route_helpers::{
    check_date_order, optional_sales_tax_entity, page_params, require_sales_tax_entity,
};
use weldsuite_books_domain::tables::EXEMPTION_CERTIFICATES as T;
use weldsuite_catalogs::entity_events::{
    EXEMPTION_CERTIFICATE_CREATED, EXEMPTION_CERTIFICATE_DELETED, EXEMPTION_CERTIFICATE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{changes, iso_date, keep, merged, refuse, text, today};

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

const REASONS: [&str; 6] = [
    "resale",
    "nonprofit",
    "government",
    "manufacturing",
    "agricultural",
    "other",
];
const FORMS: [&str; 4] = ["sst_f0003", "mtc_uniform", "state_form", "other"];
const STATUSES: [&str; 4] = ["valid", "expired", "pending", "revoked"];

/// SST: a certificate received within 90 days of an exempt sale cures it.
const CURE_DAYS: i64 = 90;

#[derive(Default)]
struct CertificateBody {
    party_id: Field<String>,
    states: Field<Vec<String>>,
    reason: Field<String>,
    certificate_number: Field<String>,
    form: Field<String>,
    issued_on: Field<String>,
    expires_on: Field<String>,
    blanket: Field<bool>,
    invoice_id: Field<String>,
    document_id: Field<String>,
    status: Field<String>,
    received_on: Field<String>,
    notes: Field<String>,
}

fn read_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> CertificateBody {
    let required = if update {
        Presence::Optional
    } else {
        Presence::Required
    };
    let optional = Presence::Optional;
    let nullish = Presence::Nullish;
    let party_id = if update {
        Field::Absent
    } else {
        issues.text(body, "partyId", Presence::Required, Some(1), Some(30))
    };
    let states = issues.list(body, "states", required, Some(1), Some(60), |i, item| {
        let text = i.item_text(item, weldsuite_kit::validation::Text::default())?;
        let len = text.encode_utf16().count();
        if len == 2 {
            Some(text)
        } else {
            let path = i.path_here();
            let (code, bound) = if len < 2 {
                ("too_small", "minimum")
            } else {
                ("too_big", "maximum")
            };
            i.issue_here(json!({
                "code": code,
                bound: 2,
                "type": "string",
                "inclusive": true,
                "exact": true,
                "message": "String must contain exactly 2 character(s)",
                "path": path,
            }));
            None
        }
    });
    CertificateBody {
        party_id,
        states,
        reason: issues.choice(body, "reason", required, &REASONS),
        certificate_number: issues.text(body, "certificateNumber", nullish, None, Some(100)),
        form: issues.choice(body, "form", optional, &FORMS),
        issued_on: iso_date(issues, body, "issuedOn", nullish),
        expires_on: iso_date(issues, body, "expiresOn", nullish),
        blanket: issues.boolean(body, "blanket", optional),
        invoice_id: issues.text(body, "invoiceId", nullish, None, Some(30)),
        document_id: issues.text(body, "documentId", nullish, None, Some(30)),
        status: issues.choice(body, "status", optional, &STATUSES),
        received_on: iso_date(issues, body, "receivedOn", nullish),
        notes: issues.text(body, "notes", nullish, None, Some(5000)),
    }
}

fn normalize_states(states: &[String]) -> Result<Vec<String>, Refusal> {
    let mut codes: Vec<String> = Vec::new();
    for state in states {
        let code = js_trim(state).to_uppercase();
        if !codes.contains(&code) {
            codes.push(code);
        }
    }
    let unknown: Vec<&String> = codes
        .iter()
        .filter(|c| us::state(Some(c)).is_none())
        .collect();
    if !unknown.is_empty() {
        return Err(refuse(
            format!(
                "Unknown US state code{}: {}",
                if unknown.len() > 1 { "s" } else { "" },
                unknown
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            400,
        ));
    }
    Ok(codes)
}

/// The customer, the invoice and the scan exist.
async fn check_references(
    db: &PgPool,
    entity_id: &str,
    party_id: Option<&str>,
    invoice_id: Option<&str>,
    document_id: Option<&str>,
) -> Result<(), Refusal> {
    if let Some(party) = party_id.filter(|p| !p.is_empty()) {
        let found: Option<String> =
            sqlx::query_scalar("select id from parties where id = $1 limit 1")
                .bind(party)
                .fetch_optional(db)
                .await?;
        if found.is_none() {
            return Err(refuse(format!("Customer {party} not found"), 400));
        }
    }
    if let Some(invoice) = invoice_id.filter(|i| !i.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(
            "select id from invoices where id = $1 and entity_id = $2 and deleted_at is null limit 1",
        )
        .bind(invoice)
        .bind(entity_id)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Err(refuse(format!("Invoice {invoice} not found"), 400));
        }
    }
    if let Some(document) = document_id.filter(|d| !d.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(
            "select id from documents where id = $1 and deleted_at is null limit 1",
        )
        .bind(document)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Err(refuse(format!("Document {document} not found"), 400));
        }
    }
    Ok(())
}

/// The tax date of the last sale made on each certificate.
pub(crate) async fn last_used_by_certificate(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<(String, Option<String>)>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select certificate_id, max(tax_date)::text from tax_lines where entity_id = $1 \
         and certificate_id = any($2) group by certificate_id",
    )
    .bind(entity_id)
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, last)| id.map(|id| (id, last)))
        .collect())
}

fn last_used<'a>(map: &'a [(String, Option<String>)], id: &str) -> Option<&'a str> {
    map.iter()
        .find(|(c, _)| c == id)
        .and_then(|(_, last)| last.as_deref())
}

/// `presentCertificate(row, lastUsedOn, day)`: the certificate with its
/// status worked out for `day`.
pub(crate) fn present_certificate(row: &Value, last_used_on: Option<&str>, day: &str) -> Value {
    let reference = to_certificate_ref(row, last_used_on.map(str::to_owned));
    let mut expiry_by_state = Map::new();
    let mut expiries: Vec<Option<String>> = Vec::new();
    for state in &reference.states {
        let expiry = certificate_expiry(&reference, state);
        expiry_by_state.insert(state.clone(), json!(expiry));
        expiries.push(expiry);
    }
    // `Object.values(expiryByState)`: one per distinct state.
    let expiries: Vec<Option<String>> = expiry_by_state
        .values()
        .map(|v| v.as_str().map(str::to_owned))
        .collect();
    let expired_states: Vec<&String> = reference
        .states
        .iter()
        .filter(|s| {
            expiry_by_state
                .get(*s)
                .and_then(Value::as_str)
                .is_some_and(|e| e < day)
        })
        .collect();
    let all_expired =
        !reference.states.is_empty() && expired_states.len() == reference.states.len();
    let stored = text(row, "status").unwrap_or("");
    let status = if stored == "revoked" || stored == "pending" {
        stored
    } else if all_expired || stored == "expired" {
        "expired"
    } else {
        "valid"
    };
    let effective = if !expiries.is_empty() && expiries.iter().all(Option::is_some) {
        expiries.iter().flatten().max().cloned()
    } else {
        None
    };
    let days_until = effective
        .as_deref()
        .and_then(|e| weldsuite_books_domain::dates::diff_days(day, e));
    let mut out = row.as_object().cloned().unwrap_or_default();
    out.insert("status".into(), json!(status));
    out.insert(
        "storedStatus".into(),
        row.get("status").cloned().unwrap_or(Value::Null),
    );
    out.insert("expiryByState".into(), Value::Object(expiry_by_state));
    out.insert("expiredStates".into(), json!(expired_states));
    out.insert("effectiveExpiresOn".into(), json!(effective));
    out.insert("daysUntilExpiry".into(), json!(days_until));
    out.insert("lastUsedOn".into(), json!(last_used_on));
    Value::Object(out)
}

fn event_data(row: &Value, status: Option<&str>) -> Value {
    json!({
        "id": row["id"],
        "partyId": row["partyId"],
        "states": row["states"],
        "reason": row["reason"],
        "status": status.map_or_else(|| row["status"].clone(), |s| json!(s)),
    })
}

async fn require_certificate(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(exemption_certificates),
        " from exemption_certificates t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| T.js(r))
        .ok_or_else(|| refuse(format!("Exemption certificate {id} not found"), 404))
}

/// `linkCertificateToEarlierSales(db, entityId, certificate, today)`: links
/// the certificate to the customer's uncured exempt sales it covers (within
/// 90 days before it was received, not on a filed return); how many
/// documents it cured.
pub(crate) async fn link_certificate_to_earlier_sales(
    db: &PgPool,
    entity_id: &str,
    certificate: &Value,
    today: &str,
) -> Result<usize, sqlx::Error> {
    let states: Vec<String> = certificate["states"]
        .as_array()
        .map(|s| {
            s.iter()
                .filter_map(Value::as_str)
                .map(str::to_uppercase)
                .collect()
        })
        .unwrap_or_default();
    if text(certificate, "status") != Some("valid") || states.is_empty() {
        return Ok(0);
    }
    let received = text(certificate, "receivedOn")
        .filter(|r| !r.is_empty())
        .unwrap_or(today);
    let Some(since) = weldsuite_books_domain::dates::add_days(received, -CURE_DAYS) else {
        return Ok(0);
    };
    let single = certificate["blanket"].as_bool() == Some(false);
    let invoice = text(certificate, "invoiceId").filter(|i| !i.is_empty());
    if single && invoice.is_none() {
        return Ok(0);
    }
    let linked: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "update tax_lines set certificate_id = $1 where entity_id = $2 and contact_id = $3 \
         and direction = 'sales' and certificate_id is null and tax_return_id is null \
         and coalesce(exempt_amount, 0) > 0 \
         and upper(coalesce(nullif(ship_to_state, ''), state_code)) = any($4) \
         and tax_date >= $5::date \
         and (not $6 or (source_type = 'invoice' and source_id = $7)) \
         returning source_type, source_id",
    )
    .bind(text(certificate, "id"))
    .bind(entity_id)
    .bind(text(certificate, "partyId"))
    .bind(&states)
    .bind(&since)
    .bind(single)
    .bind(invoice)
    .fetch_all(db)
    .await?;
    let mut documents: Vec<String> = linked
        .iter()
        .map(|(t, s)| {
            format!(
                "{}:{}",
                t.as_deref().unwrap_or(""),
                s.as_deref().unwrap_or("")
            )
        })
        .collect();
    documents.sort();
    documents.dedup();
    Ok(documents.len())
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
            entity_type: "exemption_certificate",
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
        list_certificates(&caller, &state, &q).await,
        "Failed to fetch exemption certificates",
    )
}

async fn list_certificates(caller: &Caller, state: &BooksState, q: &Query) -> Reply {
    let Some(entity) = optional_sales_tax_entity(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let entity_id = text(&entity, "id").unwrap_or_default();
    let (_, page_size, offset) = page_params(q);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(exemption_certificates),
        " from exemption_certificates t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::text is null or t.party_id = $2) order by t.created_at desc"
    ))
    .bind(entity_id)
    .bind(q.present("partyId"))
    .fetch_all(&caller.db)
    .await?;
    let rows = T.js_rows(rows);
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let used = last_used_by_certificate(&caller.db, entity_id, &ids).await?;
    let day = today(caller, state);
    let mut presented: Vec<Value> = rows
        .iter()
        .map(|row| present_certificate(row, last_used(&used, text(row, "id").unwrap_or("")), &day))
        .collect();
    if let Some(status) = q.present("status") {
        presented.retain(|r| text(r, "status") == Some(status));
    }
    let within = q
        .get("expiringWithinDays")
        .and_then(weldsuite_books_domain::js::parse_int);
    if let Some(within) = within.filter(|w| *w >= 0) {
        let limit = weldsuite_books_domain::dates::add_days(&day, within).unwrap_or_default();
        presented.retain(|r| {
            text(r, "status") == Some("valid")
                && text(r, "effectiveExpiresOn")
                    .is_some_and(|e| e >= day.as_str() && e <= limit.as_str())
        });
        presented.sort_by(|a, b| {
            text(a, "effectiveExpiresOn")
                .unwrap_or("")
                .cmp(text(b, "effectiveExpiresOn").unwrap_or(""))
        });
    }
    let total = i64::try_from(presented.len()).unwrap_or(i64::MAX);
    let start = usize::try_from(offset).unwrap_or(0).min(presented.len());
    let end = (start + usize::try_from(page_size).unwrap_or(0)).min(presented.len());
    let page_rows = presented[start..end].to_vec();
    Ok(paged(page_rows, total, offset + page_size < total, None))
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
            let row = require_certificate(&caller.db, &entity_id, &id).await?;
            let used =
                last_used_by_certificate(&caller.db, &entity_id, std::slice::from_ref(&id)).await?;
            Ok(ok(present_certificate(
                &row,
                last_used(&used, &id),
                &today(&caller, &state),
            )))
        }
        .await,
        "Failed to fetch exemption certificate",
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
        Err(refusal) => return refusal.respond("Failed to create exemption certificate"),
    };
    reply(
        create_certificate(&caller, &state, data).await,
        "Failed to create exemption certificate",
    )
}

fn date_order(issued: Option<&str>, expires: Option<&str>) -> Result<(), Refusal> {
    if let Some(issued) = issued.filter(|i| !i.is_empty()) {
        check_date_order(issued, expires, "the certificate")
            .map_err(|e| Refusal::Response(Box::new(e.response())))?;
    }
    Ok(())
}

async fn create_certificate(caller: &Caller, state: &BooksState, data: CertificateBody) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let states = normalize_states(data.states.as_set().map_or(&[], Vec::as_slice))?;
    date_order(
        data.issued_on.as_set().map(String::as_str),
        data.expires_on.as_set().map(String::as_str),
    )?;
    check_references(
        &caller.db,
        &entity_id,
        data.party_id.as_set().map(String::as_str),
        data.invoice_id.as_set().map(String::as_str),
        data.document_id.as_set().map(String::as_str),
    )
    .await?;
    let blanket = data.blanket.as_set().copied().unwrap_or(true);
    if blanket && data.invoice_id.as_set().is_some_and(|i| !i.is_empty()) {
        return Err(refuse(
            "A blanket certificate covers every purchase; leave the invoice empty, or mark it single-purchase",
            400,
        ));
    }
    let at = now();
    let day = today(caller, state);
    let id = generate_id("exc");
    let row = json!({
        "id": id,
        "entityId": entity_id,
        "partyId": data.party_id.as_set(),
        "states": states,
        "reason": data.reason.as_set(),
        "certificateNumber": data.certificate_number.as_set().map(|n| js_trim(n)).filter(|n| !n.is_empty()),
        "form": data.form.as_set().map_or("state_form", String::as_str),
        "issuedOn": data.issued_on.as_set(),
        "expiresOn": data.expires_on.as_set(),
        "blanket": blanket,
        "invoiceId": data.invoice_id.as_set(),
        "documentId": data.document_id.as_set(),
        "status": data.status.as_set().map_or("valid", String::as_str),
        "receivedOn": data.received_on.as_set().cloned().unwrap_or_else(|| day.clone()),
        "notes": data.notes.as_set(),
        "createdAt": at,
        "updatedAt": at,
    });
    T.insert_raw(&caller.db, T.values(row.as_object().unwrap_or(&Map::new())))
        .await?;
    audit(caller, &entity_id, &id, "created", None).await;
    let linked = link_certificate_to_earlier_sales(&caller.db, &entity_id, &row, &day).await?;
    let used = if linked > 0 {
        last_used_by_certificate(&caller.db, &entity_id, std::slice::from_ref(&id)).await?
    } else {
        Vec::new()
    };
    let presented = present_certificate(&row, last_used(&used, &id), &day);
    caller.publish(
        state,
        EXEMPTION_CERTIFICATE_CREATED,
        &id,
        event_data(&row, text(&presented, "status")),
    );
    let mut out = presented.as_object().cloned().unwrap_or_default();
    out.insert("linkedSales".into(), json!(linked));
    Ok(created(Value::Object(out)))
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
        Err(refusal) => return refusal.respond("Failed to update exemption certificate"),
    };
    reply(
        update_certificate(&caller, &state, &id, data).await,
        "Failed to update exemption certificate",
    )
}

async fn update_certificate(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: CertificateBody,
) -> Reply {
    let entity = require_sales_tax_entity(caller).await?;
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let row = require_certificate(&caller.db, &entity_id, id).await?;
    let or_row = |field: &Field<String>, key: &str| match field {
        Field::Absent => text(&row, key).map(str::to_owned),
        Field::Null => None,
        Field::Set(v) => Some(v.clone()),
    };
    let issued = or_row(&data.issued_on, "issuedOn");
    let expires = or_row(&data.expires_on, "expiresOn");
    date_order(issued.as_deref(), expires.as_deref())?;
    check_references(
        &caller.db,
        &entity_id,
        None,
        data.invoice_id.as_set().map(String::as_str),
        data.document_id.as_set().map(String::as_str),
    )
    .await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    if let Field::Set(states) = &data.states {
        update.insert("states".into(), json!(normalize_states(states)?));
    }
    keep(&mut update, "reason", &data.reason);
    match &data.certificate_number {
        Field::Set(n) => {
            let n = js_trim(n);
            update.insert(
                "certificateNumber".into(),
                if n.is_empty() { Value::Null } else { json!(n) },
            );
        }
        Field::Null => {
            update.insert("certificateNumber".into(), Value::Null);
        }
        Field::Absent => {}
    }
    keep(&mut update, "form", &data.form);
    keep(&mut update, "issuedOn", &data.issued_on);
    keep(&mut update, "expiresOn", &data.expires_on);
    keep(&mut update, "blanket", &data.blanket);
    keep(&mut update, "invoiceId", &data.invoice_id);
    keep(&mut update, "documentId", &data.document_id);
    keep(&mut update, "status", &data.status);
    keep(&mut update, "receivedOn", &data.received_on);
    keep(&mut update, "notes", &data.notes);
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
    let day = today(caller, state);
    let linked = link_certificate_to_earlier_sales(&caller.db, &entity_id, &updated, &day).await?;
    let used = last_used_by_certificate(&caller.db, &entity_id, &[id.to_owned()]).await?;
    let presented = present_certificate(&updated, last_used(&used, id), &day);
    caller.publish(
        state,
        EXEMPTION_CERTIFICATE_UPDATED,
        id,
        event_data(&updated, text(&presented, "status")),
    );
    let mut out = presented.as_object().cloned().unwrap_or_default();
    out.insert("linkedSales".into(), json!(linked));
    Ok(ok(Value::Object(out)))
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
            let row = require_certificate(&caller.db, &entity_id, &id).await?;
            sqlx::query(
                "update exemption_certificates set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
            )
            .bind(now())
            .bind(&id)
            .execute(&caller.db)
            .await?;
            audit(&caller, &entity_id, &id, "deleted", None).await;
            caller.publish(&state, EXEMPTION_CERTIFICATE_DELETED, &id, event_data(&row, None));
            Ok(no_content())
        }
        .await,
        "Failed to delete exemption certificate",
    )
}
