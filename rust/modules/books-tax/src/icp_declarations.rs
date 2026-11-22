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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_books_domain::compliance::get_contact_vat_number;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::vies::{NormalizedVat, normalize_vat_number};
use weldsuite_catalogs::entity_events::{
    VAT_RETURN_CREATED, VAT_RETURN_DELETED, VAT_RETURN_UPDATED,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{entities, icp_declarations, icp_lines};

use crate::filing::{
    is_unfiled, iso_day, load_period_lines, overlapping_period, parse_period, submit_filing,
};
use crate::nl::{self, IcpXmlInput, IcpXmlLine};
use crate::orm_bridge::{day_of, decimal_of, refused, timestamp_of_iso, to_json, to_json_rows};
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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("icp_declarations"), "ICP declaration")
                .layer(),
        )
        .with_state(state)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A live declaration, as Drizzle returns it.
async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    icp_declarations::Entity::find()
        .filter(icp_declarations::Column::Id.eq(id))
        .filter(icp_declarations::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(to_json)
        .transpose()
}

/// The declaration's lines, in the database's order (no `order by`).
async fn lines_of(db: &PgPool, id: &str) -> Result<Vec<Value>, DbErr> {
    let rows = icp_lines::Entity::find()
        .filter(icp_lines::Column::DeclarationId.eq(id))
        .all(&orm(db))
        .await?;
    to_json_rows(rows)
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
            let rows = icp_declarations::Entity::find()
                .filter(icp_declarations::Column::DeletedAt.is_null())
                .filter(icp_declarations::Column::EntityId.eq(&entity_id))
                .order_by_desc(icp_declarations::Column::PeriodStart)
                .all(&orm(&caller.db))
                .await
                .and_then(to_json_rows)
                .map_err(refused)?;
            Ok(ok(Value::Array(rows)))
        }
        .await,
        "Failed to fetch ICP declarations",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(declaration) = find(&caller.db, &id).await.map_err(refused)? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            let rows = icp_lines::Entity::find()
                .filter(icp_lines::Column::DeclarationId.eq(&id))
                .order_by_asc(icp_lines::Column::VatNumber)
                .all(&orm(&caller.db))
                .await
                .and_then(to_json_rows)
                .map_err(refused)?;
            let mut body = declaration.as_object().cloned().unwrap_or_default();
            body.insert("lines".into(), Value::Array(rows));
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
    let code: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::JurisdictionCode)
        .filter(entities::Column::Id.eq(&entity_id))
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(refused)?;
    if !has_feature(code.as_deref(), "icp") {
        return Err(Refusal::bad_request(
            "ICP declarations only apply to EU (Dutch) entities",
        ));
    }
    let (start, end) = parse_period(&data.period_start, &data.period_end, &data.period_type)
        .map_err(Refusal::bad_request)?;
    let (start_at, end_at) = (
        timestamp_of_iso(&start).map_err(refused)?,
        timestamp_of_iso(&end).map_err(refused)?,
    );
    // Declarations never overlap: the supplies of a month are declared once.
    let periods: Vec<(PrimitiveDateTime, PrimitiveDateTime)> = icp_declarations::Entity::find()
        .select_only()
        .column(icp_declarations::Column::PeriodStart)
        .column(icp_declarations::Column::PeriodEnd)
        .filter(icp_declarations::Column::EntityId.eq(&entity_id))
        .filter(icp_declarations::Column::PeriodStart.lte(end_at))
        .filter(icp_declarations::Column::PeriodEnd.gte(start_at))
        .filter(icp_declarations::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(refused)?;
    let periods: Vec<(String, String)> = periods
        .into_iter()
        .map(|(from, to)| (day_of(from), day_of(to)))
        .collect();
    if let Some(clash) = overlapping_period(&periods, &start, &end) {
        return Err(Refusal::bad_request(format!(
            "This period overlaps the ICP declaration of {clash}."
        )));
    }

    let existing = icp_declarations::Entity::find()
        .filter(icp_declarations::Column::EntityId.eq(&entity_id))
        .filter(icp_declarations::Column::PeriodStart.eq(start_at))
        .filter(icp_declarations::Column::PeriodEnd.eq(end_at))
        .filter(icp_declarations::Column::DeletedAt.is_null())
        .order_by_desc(icp_declarations::Column::CreatedAt)
        .one(&orm(db))
        .await
        .and_then(|row| row.map(to_json).transpose())
        .map_err(refused)?;
    if let Some(existing) = &existing
        && !is_unfiled(text(existing, "status").unwrap_or_default())
    {
        return Err(Refusal::bad_request(
            "The ICP declaration of this period has already been filed.",
        ));
    }

    let ledger = load_period_lines(db, &entity_id, &iso_day(&start), &iso_day(&end))
        .await
        .map_err(refused)?;
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

    let stamp = utc_now();
    let total: f64 = per_vat.iter().fold(0.0, |sum, s| sum + s.amount);
    let notes = (!missing.is_empty()).then(|| {
        format!(
            "Supplies for {} contact(s) were skipped because no VAT number is on their company record: {}",
            missing.len(),
            missing.join(", ")
        )
    });
    let label = data.period_label.filter(|l| !l.is_empty());
    // `total_amount` is `numeric(15, 2)`: the total as `toFixed(2)` wrote it.
    let total_amount = decimal_of(&js::to_fixed(total, 2)).map_err(refused)?;
    let id = if let Some(existing) = &existing {
        let id = text(existing, "id").unwrap_or_default().to_owned();
        let label = label
            .as_deref()
            .or_else(|| text(existing, "periodLabel"))
            .map(str::to_owned);
        icp_declarations::Entity::update_many()
            .col_expr(
                icp_declarations::Column::PeriodType,
                Expr::value(data.period_type.clone()),
            )
            .col_expr(icp_declarations::Column::PeriodLabel, Expr::value(label))
            .col_expr(icp_declarations::Column::Status, Expr::value("calculated"))
            .col_expr(
                icp_declarations::Column::TotalAmount,
                Expr::value(total_amount),
            )
            .col_expr(
                icp_declarations::Column::XmlContent,
                Expr::value(Option::<String>::None),
            )
            .col_expr(
                icp_declarations::Column::RejectedAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .col_expr(
                icp_declarations::Column::RejectionReason,
                Expr::value(Option::<String>::None),
            )
            .col_expr(icp_declarations::Column::Notes, Expr::value(notes.clone()))
            .col_expr(icp_declarations::Column::UpdatedAt, Expr::value(stamp))
            .filter(icp_declarations::Column::Id.eq(&id))
            .exec(&orm(db))
            .await
            .map_err(refused)?;
        icp_lines::Entity::delete_many()
            .filter(icp_lines::Column::DeclarationId.eq(&id))
            .exec(&orm(db))
            .await
            .map_err(refused)?;
        id
    } else {
        let id = generate_id("icp");
        icp_declarations::Entity::insert(icp_declarations::ActiveModel {
            id: Set(id.clone()),
            entity_id: Set(entity_id.clone()),
            period_type: Set(data.period_type.clone()),
            period_start: Set(start_at),
            period_end: Set(end_at),
            period_label: Set(label.clone()),
            status: Set("calculated".to_owned()),
            total_amount: Set(total_amount),
            notes: Set(notes.clone()),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await
        .map_err(refused)?;
        id
    };

    if !per_vat.is_empty() {
        // One statement for every buyer's line, the amounts as `toFixed(2)`
        // wrote them for `numeric(15, 2)`.
        let lines = per_vat
            .iter()
            .map(|supply| {
                Ok(icp_lines::ActiveModel {
                    id: Set(generate_id("icpl")),
                    declaration_id: Set(id.clone()),
                    entity_id: Set(entity_id.clone()),
                    contact_id: Set(supply.contact_id.clone()),
                    vat_number: Set(supply.vat_number.clone()),
                    country_code: Set(supply.country_code.clone()),
                    supply_type: Set(supply.supply_type.to_owned()),
                    amount: Set(decimal_of(&js::to_fixed(supply.amount, 2))?),
                    created_at: Set(stamp),
                    updated_at: Set(stamp),
                })
            })
            .collect::<Result<Vec<_>, DbErr>>()
            .map_err(refused)?;
        icp_lines::Entity::insert_many(lines)
            .exec_without_returning(&orm(db))
            .await
            .map_err(refused)?;
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
    let Some(declaration) = find(db, id).await.map_err(refused)? else {
        return Err(Refusal::not_found("ICP declaration", id));
    };
    let status = text(&declaration, "status").unwrap_or_default().to_owned();
    if status == "filed" || status == "accepted" {
        return Err(Refusal::bad_request(
            "ICP declaration has already been filed",
        ));
    }
    let lines = lines_of(db, id).await.map_err(refused)?;
    if lines.is_empty() {
        return Err(Refusal::bad_request(
            "ICP declaration has no lines — nothing to file (an ICP declaration is only due when there were intracommunautaire supplies)",
        ));
    }
    let entity_id = text(&declaration, "entityId")
        .unwrap_or_default()
        .to_owned();
    let Some(entity) = entity_row(db, &entity_id, true).await.map_err(refused)? else {
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
    let stamp = utc_now();
    icp_declarations::Entity::update_many()
        .col_expr(icp_declarations::Column::Status, Expr::value("filed"))
        .col_expr(icp_declarations::Column::XmlContent, Expr::value(xml))
        .col_expr(
            icp_declarations::Column::FilingReference,
            Expr::value(Some(submission.kenmerk.clone()).filter(|k| !k.is_empty())),
        )
        .col_expr(
            icp_declarations::Column::DigipoortResponse,
            Expr::value(submission.stored),
        )
        .col_expr(icp_declarations::Column::FiledAt, Expr::value(stamp))
        .col_expr(
            icp_declarations::Column::FiledBy,
            Expr::value(caller.user().map(str::to_owned)),
        )
        .col_expr(icp_declarations::Column::UpdatedAt, Expr::value(stamp))
        .filter(icp_declarations::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map_err(refused)?;

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
            let Some(declaration) = find(db, &id).await.map_err(refused)? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            let xml = if let Some(xml) = text(&declaration, "xmlContent").filter(|x| !x.is_empty())
            {
                xml.to_owned()
            } else {
                let lines = lines_of(db, &id).await.map_err(refused)?;
                let entity_id = text(&declaration, "entityId").unwrap_or_default();
                let entity = entity_row(db, entity_id, false).await.map_err(refused)?;
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
            let Some(declaration) = find(db, &id).await.map_err(refused)? else {
                return Err(Refusal::not_found("ICP declaration", &id));
            };
            if !is_unfiled(text(&declaration, "status").unwrap_or_default()) {
                return Err(Refusal::bad_request(
                    "A filed ICP declaration can not be deleted.",
                ));
            }
            let stamp = utc_now();
            icp_lines::Entity::delete_many()
                .filter(icp_lines::Column::DeclarationId.eq(&id))
                .exec(&orm(db))
                .await
                .map_err(refused)?;
            icp_declarations::Entity::update_many()
                .col_expr(icp_declarations::Column::DeletedAt, Expr::value(stamp))
                .col_expr(icp_declarations::Column::UpdatedAt, Expr::value(stamp))
                .filter(icp_declarations::Column::Id.eq(&id))
                .exec(&orm(db))
                .await
                .map_err(refused)?;
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
