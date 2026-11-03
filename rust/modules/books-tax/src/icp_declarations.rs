//! `/api/icp-declarations` (`routes/icp-declarations/index.ts`): the Opgaaf
//! ICP, the per-customer listing of intracommunautaire supplies (rubriek
//! 3b) by buyer VAT number and by goods vs services, from the tax ledger;
//! filed through the same (simulated) Digipoort channel as the VAT return.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::compliance::get_contact_vat_number;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::tables::{ICP_DECLARATIONS, ICP_LINES};
use weldsuite_books_domain::vies::{NormalizedVat, normalize_vat_number};
use weldsuite_catalogs::entity_events::{
    VAT_RETURN_CREATED, VAT_RETURN_DELETED, VAT_RETURN_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::filing::{is_unfiled, iso_day, load_period_lines, parse_period, submit_filing};
use crate::nl::{self, IcpXmlInput, IcpXmlLine};
use crate::vat_returns::{
    PeriodBody, btw_number, company_name, entity_row, has_feature, phone, read_period, xml_response,
};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("reports:read")))
        .route("/{id}", get(detail).route_layer(need("reports:read")))
        .route(
            "/calculate",
            post(calculate).route_layer(need("reports:create")),
        )
        .route("/{id}/file", post(file).route_layer(need("reports:update")))
        .route("/{id}/xml", get(xml).route_layer(need("reports:read")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("reports:delete")),
        )
        .with_state(state)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(icp_declarations),
        " from icp_declarations t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ICP_DECLARATIONS.js(row)))
}

/// The declaration's lines, in the database's order (no `order by`).
async fn lines_of(db: &PgPool, id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(icp_lines),
        " from icp_lines t where t.declaration_id = $1"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(ICP_LINES.js_rows(rows))
}

fn xml_lines(lines: &[Value]) -> Vec<IcpXmlLine> {
    lines
        .iter()
        .map(|line| IcpXmlLine {
            vat_number: text(line, "vatNumber").unwrap_or_default().to_owned(),
            country_code: text(line, "countryCode").unwrap_or_default().to_owned(),
            supply_type: text(line, "supplyType").unwrap_or("services").to_owned(),
            amount: js::numeric_text(text(line, "amount")),
        })
        .collect()
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(icp_declarations),
                " from icp_declarations t where t.deleted_at is null and t.entity_id = $1 \
                 order by t.period_start desc"
            ))
            .bind(&entity_id)
            .fetch_all(&caller.db)
            .await?;
            Ok(ok(Value::Array(ICP_DECLARATIONS.js_rows(rows))))
        }
        .await,
        "Failed to fetch ICP declarations",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(declaration) = find(&caller.db, &id).await? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(icp_lines),
                " from icp_lines t where t.declaration_id = $1 order by t.vat_number asc"
            ))
            .bind(&id)
            .fetch_all(&caller.db)
            .await?;
            let mut body = declaration.as_object().cloned().unwrap_or_default();
            body.insert("lines".into(), Value::Array(ICP_LINES.js_rows(rows)));
            Ok(ok(Value::Object(body)))
        }
        .await,
        "Failed to fetch ICP declaration",
    )
}

// ── POST /calculate ─────────────────────────────────────────────────────────

/// `supplyTypeOf(code)`: goods leave on the ICL-goods rate.
fn supply_type_of(category: &str) -> &'static str {
    if category == "eu_b2b_goods" {
        "goods"
    } else {
        "services"
    }
}

struct BuyerSupply {
    key: String,
    vat_number: String,
    country_code: String,
    contact_id: Option<String>,
    supply_type: &'static str,
    amount: f64,
}

async fn calculate(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_period) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to calculate ICP declaration"),
    };
    reply(
        calculate_declaration(&caller, &state, data).await,
        "Failed to calculate ICP declaration",
    )
}

#[allow(clippy::too_many_lines)] // mirrors the route's one handler
async fn calculate_declaration(caller: &Caller, state: &BooksState, data: PeriodBody) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let code: Option<Option<String>> =
        sqlx::query_scalar("select jurisdiction_code from entities where id = $1 limit 1")
            .bind(&entity_id)
            .fetch_optional(db)
            .await?;
    if !has_feature(code.flatten().as_deref(), "icp") {
        return Err(Refusal::bad_request(
            "ICP declarations only apply to EU (Dutch) entities",
        ));
    }
    let (start, end) =
        parse_period(&data.period_start, &data.period_end).map_err(Refusal::bad_request)?;

    let existing: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(icp_declarations),
        " from icp_declarations t where t.entity_id = $1 and t.period_start = $2::timestamp \
         and t.period_end = $3::timestamp and t.deleted_at is null order by t.created_at desc limit 1"
    ))
    .bind(&entity_id)
    .bind(&start)
    .bind(&end)
    .fetch_optional(db)
    .await?;
    let existing = existing.map(|row| ICP_DECLARATIONS.js(row));
    if let Some(existing) = &existing
        && !is_unfiled(text(existing, "status").unwrap_or_default())
    {
        return Err(Refusal::bad_request(
            "The ICP declaration of this period has already been filed.",
        ));
    }

    let ledger = load_period_lines(db, &entity_id, &iso_day(&start), &iso_day(&end)).await?;
    let mut per_vat: Vec<BuyerSupply> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut vat_of: HashMap<String, Option<NormalizedVat>> = HashMap::new();
    for entry in ledger.iter().filter(|l| {
        l.line.direction == "sales"
            && l.line
                .jurisdiction_metadata
                .as_ref()
                .and_then(|m| m.get("btwRubriek"))
                .and_then(Value::as_str)
                == Some("3b")
    }) {
        let amount = entry.line.taxable_amount;
        if amount == 0.0 {
            continue;
        }
        let supply_type = supply_type_of(&entry.line.tax_category_code);
        let normalized = match entry.contact_id.as_deref().filter(|id| !id.is_empty()) {
            None => None,
            Some(contact_id) => {
                if let Some(cached) = vat_of.get(contact_id) {
                    cached.clone()
                } else {
                    let raw = get_contact_vat_number(db, Some(contact_id)).await?;
                    let normalized = raw
                        .as_deref()
                        .filter(|r| !r.is_empty())
                        .and_then(normalize_vat_number);
                    vat_of.insert(contact_id.to_owned(), normalized.clone());
                    normalized
                }
            }
        };
        let Some(buyer) = normalized else {
            if let Some(contact_id) = entry.contact_id.as_deref().filter(|id| !id.is_empty())
                && !missing.iter().any(|m| m == contact_id)
            {
                missing.push(contact_id.to_owned());
            }
            continue;
        };
        let key = format!("{}|{supply_type}", buyer.full);
        if let Some(found) = per_vat.iter_mut().find(|s| s.key == key) {
            found.amount += amount;
        } else {
            per_vat.push(BuyerSupply {
                key,
                vat_number: buyer.full,
                country_code: buyer.country_code,
                contact_id: entry.contact_id.clone(),
                supply_type,
                amount,
            });
        }
    }
    // A buyer whose credit notes cancel the period's supplies has nothing to report.
    for supply in &mut per_vat {
        supply.amount = js::math_round(supply.amount * 100.0) / 100.0;
    }
    per_vat.retain(|s| s.amount != 0.0);

    let now = now();
    let total: f64 = per_vat.iter().fold(0.0, |sum, s| sum + s.amount);
    let notes = (!missing.is_empty()).then(|| {
        format!(
            "Supplies for {} contact(s) were skipped because no VAT number is on their company record: {}",
            missing.len(),
            missing.join(", ")
        )
    });
    let label = data.period_label.filter(|l| !l.is_empty());
    let id = if let Some(existing) = &existing {
        let id = text(existing, "id").unwrap_or_default().to_owned();
        sqlx::query(
            "update icp_declarations set period_type = $1, period_label = $2, status = 'calculated', \
             total_amount = $3::numeric, xml_content = null, rejected_at = null, rejection_reason = null, \
             notes = $4, updated_at = $5::timestamp where id = $6",
        )
        .bind(&data.period_type)
        .bind(label.as_deref().or_else(|| text(existing, "periodLabel")))
        .bind(js::to_fixed(total, 2))
        .bind(notes.as_deref())
        .bind(&now)
        .bind(&id)
        .execute(db)
        .await?;
        sqlx::query("delete from icp_lines where declaration_id = $1")
            .bind(&id)
            .execute(db)
            .await?;
        id
    } else {
        let id = generate_id("icp");
        sqlx::query(
            "insert into icp_declarations (id, entity_id, period_type, period_start, period_end, \
             period_label, status, total_amount, notes, created_at, updated_at) \
             values ($1, $2, $3, $4::timestamp, $5::timestamp, $6, 'calculated', $7::numeric, $8, \
             $9::timestamp, $9::timestamp)",
        )
        .bind(&id)
        .bind(&entity_id)
        .bind(&data.period_type)
        .bind(&start)
        .bind(&end)
        .bind(label.as_deref())
        .bind(js::to_fixed(total, 2))
        .bind(notes.as_deref())
        .bind(&now)
        .execute(db)
        .await?;
        id
    };

    if !per_vat.is_empty() {
        let ids: Vec<String> = per_vat.iter().map(|_| generate_id("icpl")).collect();
        let contacts: Vec<Option<String>> = per_vat.iter().map(|s| s.contact_id.clone()).collect();
        let vats: Vec<String> = per_vat.iter().map(|s| s.vat_number.clone()).collect();
        let countries: Vec<String> = per_vat.iter().map(|s| s.country_code.clone()).collect();
        let types: Vec<String> = per_vat.iter().map(|s| s.supply_type.to_owned()).collect();
        let amounts: Vec<String> = per_vat.iter().map(|s| js::to_fixed(s.amount, 2)).collect();
        sqlx::query(
            "insert into icp_lines (id, declaration_id, entity_id, contact_id, vat_number, country_code, \
             supply_type, amount, created_at, updated_at) \
             select u.id, $2, $3, u.contact_id, u.vat_number, u.country_code, u.supply_type, \
             u.amount::numeric, $9::timestamp, $9::timestamp \
             from unnest($1::varchar[], $4::varchar[], $5::varchar[], $6::varchar[], $7::varchar[], $8::text[]) \
             as u(id, contact_id, vat_number, country_code, supply_type, amount)",
        )
        .bind(&ids)
        .bind(&id)
        .bind(&entity_id)
        .bind(&contacts)
        .bind(&vats)
        .bind(&countries)
        .bind(&types)
        .bind(&amounts)
        .bind(&now)
        .execute(db)
        .await?;
    }

    let recalculated = existing.is_some();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "icp_declaration",
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
        json!({ "id": id, "kind": "icp", "totalAmount": js::number_value(total) }),
    );
    let body = json!({
        "id": id,
        "totalAmount": js::number_value(total),
        "lineCount": per_vat.len(),
        "skippedContacts": missing,
        "recalculated": recalculated,
    });
    Ok(if recalculated {
        ok(body)
    } else {
        created(body)
    })
}

// ── POST /:id/file ──────────────────────────────────────────────────────────

async fn file(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    reply(
        file_declaration(&caller, &state, &id).await,
        "Failed to file ICP declaration",
    )
}

async fn file_declaration(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(declaration) = find(db, id).await? else {
        return Err(Refusal::not_found("ICP declaration", id));
    };
    let status = text(&declaration, "status").unwrap_or_default().to_owned();
    if status == "filed" || status == "accepted" {
        return Err(Refusal::bad_request(
            "ICP declaration has already been filed",
        ));
    }
    let lines = lines_of(db, id).await?;
    if lines.is_empty() {
        return Err(Refusal::bad_request(
            "ICP declaration has no lines — nothing to file (an ICP declaration is only due when there were intracommunautaire supplies)",
        ));
    }
    let entity_id = text(&declaration, "entityId")
        .unwrap_or_default()
        .to_owned();
    let Some(entity) = entity_row(db, &entity_id, true).await? else {
        return Err(Refusal::not_found("Entity", &entity_id));
    };
    let Some(btw) = btw_number(&entity) else {
        return Err(Refusal::bad_request(
            "VAT/BTW number is not configured on this entity",
        ));
    };
    if phone(&entity).is_empty() {
        return Err(Refusal::bad_request(
            "A telephone number is required in the ICP message. Add it to the entity contact details first.",
        ));
    }
    let xml = icp_xml(&declaration, &entity, &btw, &lines);
    let submission = submit_filing(&btw, &xml, "Opgaaf ICP");
    let now = now();
    sqlx::query(
        "update icp_declarations set status = 'filed', xml_content = $1, filing_reference = $2, \
         digipoort_response = $3, filed_at = $4::timestamp, filed_by = $5, updated_at = $4::timestamp \
         where id = $6",
    )
    .bind(&xml)
    .bind(Some(&submission.kenmerk).filter(|k| !k.is_empty()))
    .bind(&submission.stored)
    .bind(&now)
    .bind(caller.user())
    .bind(id)
    .execute(db)
    .await?;

    let mut changes = Map::new();
    changes.insert("status".into(), change(json!(status), json!("filed")));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "icp_declaration",
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
        json!({ "id": id, "kind": "icp", "status": "filed" }),
    );
    Ok(ok(json!({
        "id": id,
        "status": "filed",
        "kenmerk": submission.kenmerk,
        "digipoortSuccess": true,
        "simulated": true,
    })))
}

fn icp_xml(declaration: &Value, entity: &Value, btw: &str, lines: &[Value]) -> String {
    let id = text(declaration, "id").unwrap_or_default();
    let name = company_name(entity);
    nl::generate_icp_xml(&IcpXmlInput {
        btw_number: btw,
        contact_name: &name,
        contact_phone: &phone(entity),
        message_reference: &format!("ICP-{id}"),
        period_start: text(declaration, "periodStart").unwrap_or_default(),
        period_end: text(declaration, "periodEnd").unwrap_or_default(),
        lines: &xml_lines(lines),
        now: &now(),
    })
}

// ── GET /:id/xml ────────────────────────────────────────────────────────────

async fn xml(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let db = &caller.db;
            let Some(declaration) = find(db, &id).await? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            let xml = if let Some(xml) = text(&declaration, "xmlContent").filter(|x| !x.is_empty())
            {
                xml.to_owned()
            } else {
                let lines = lines_of(db, &id).await?;
                let entity_id = text(&declaration, "entityId").unwrap_or_default();
                let entity = entity_row(db, entity_id, false).await?;
                let btw = entity.as_ref().and_then(btw_number);
                let (Some(entity), Some(btw)) = (entity, btw) else {
                    return Err(Refusal::bad_request(
                        "VAT/BTW number is not configured on this entity",
                    ));
                };
                icp_xml(&declaration, &entity, &btw, &lines)
            };
            let label = text(&declaration, "periodLabel")
                .filter(|l| !l.is_empty())
                .unwrap_or(&id);
            Ok(xml_response(xml, &format!("opgaaf-icp-{label}.xml")))
        }
        .await,
        "Failed to get ICP XML",
    )
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
            let Some(declaration) = find(db, &id).await? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            if !is_unfiled(text(&declaration, "status").unwrap_or_default()) {
                return Err(Refusal::bad_request(
                    "A filed ICP declaration can not be deleted.",
                ));
            }
            let now = now();
            sqlx::query("delete from icp_lines where declaration_id = $1")
                .bind(&id)
                .execute(db)
                .await?;
            sqlx::query(
                "update icp_declarations set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
            )
            .bind(&now)
            .bind(&id)
            .execute(db)
            .await?;
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: text(&declaration, "entityId"),
                    entity_type: "icp_declaration",
                    entity_id: &id,
                    action: "deleted",
                    changes: None,
                },
            )
            .await;
            caller.publish(
                &state,
                VAT_RETURN_DELETED,
                &id,
                json!({ "id": id, "kind": "icp" }),
            );
            Ok(no_content())
        }
        .await,
        "Failed to delete ICP declaration",
    )
}
