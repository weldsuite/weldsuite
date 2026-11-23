//! `/api/sales-tax/nexus` (`routes/sales-tax/nexus.ts`,
//! `services/nexus-monitor.ts`): the economic nexus monitor.
//!
//! Sales into each state come from the tax ledger (every sales row, zero-tax
//! rows and marketplace sales included), one transaction per document and
//! state; invoices that wrote no ledger rows fall back to their ship-to (else
//! bill-to) state and subtotal. Each state is measured with its own rule by
//! `weldsuite_books_domain::nexus`.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::StatusCode;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Query as SqlQuery};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::{BooksState, Caller, Query, Refusal, ok, reply};
use weldsuite_books_domain::js::locale_compare;
use weldsuite_books_domain::nexus::{
    NexusRule, NexusSale, get_nexus_rule, nexus_monitor, nexus_monitored_codes,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{invoices, tax_lines};

use crate::common::{is_iso_date_text, text, today_in};
use crate::returns::common::{
    add_months, bad, day_start, day_text, decimal_num, load_agencies, n, next_day, num_at,
    parse_day, registered_on, round2, rows_json, s, state_of_address, sum_money, us_entity_of,
};
use crate::returns::documents::{anchor_rows, document_key};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = || gate.require(["taxes:read".to_owned()]);
    Router::new()
        .route("/nexus", get(overview).route_layer(need()))
        .route("/nexus/{state}", get(detail).route_layer(need()))
        .with_state(state)
}

/// `NexusDocument`: one document's sales into one state.
#[derive(Debug, Clone)]
pub(crate) struct NexusDocument {
    pub date: String,
    pub state_code: String,
    pub gross: f64,
    pub taxable: f64,
    pub retail: f64,
    pub marketplace_facilitated: bool,
}

/// `historyStart(asOf)`: last year's calendar year, Connecticut's October
/// to September.
fn history_start(as_of: &str) -> String {
    let year: i64 = as_of.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    format!("{}-01-01", year - 2)
}

/// `loadNexusDocuments(db, entityId, asOf)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors nexus-monitor.ts's loadNexusDocuments()"
)]
pub(crate) async fn load_nexus_documents(
    db: &PgPool,
    entity_id: &str,
    as_of: &str,
) -> Result<Vec<NexusDocument>, DbErr> {
    let from = history_start(as_of);
    let rows = tax_lines::Entity::find()
        .filter(tax_lines::Column::EntityId.eq(entity_id))
        .filter(tax_lines::Column::Direction.eq("sales"))
        .filter(tax_lines::Column::TaxDate.gte(parse_day(&from)?))
        .filter(tax_lines::Column::TaxDate.lte(parse_day(as_of)?))
        .all(&orm(db))
        .await?;
    let rows = rows_json(rows)?;
    let mut by_document: Vec<(String, Vec<&Value>)> = Vec::new();
    for r in &rows {
        let key = document_key(r);
        match by_document.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(r),
            None => by_document.push((key, vec![r])),
        }
    }
    let mut docs: Vec<NexusDocument> = Vec::new();
    for (_, list) in &by_document {
        let mut by_state: Vec<(String, Vec<&Value>)> = Vec::new();
        for anchor in anchor_rows(list) {
            let state = text(anchor, "shipToState")
                .filter(|v| !v.is_empty())
                .or_else(|| text(anchor, "stateCode").filter(|v| !v.is_empty()))
                .map(|v| weldsuite_kit::validation::js_trim(v).to_uppercase())
                .unwrap_or_default();
            if state.is_empty() {
                continue;
            }
            match by_state.iter_mut().find(|(k, _)| *k == state) {
                Some((_, bucket)) => bucket.push(anchor),
                None => by_state.push((state, vec![anchor])),
            }
        }
        for (state_code, anchors) in by_state {
            let gross = sum_money(anchors.iter().map(|a| num_at(a, "grossAmount")));
            let exempt = sum_money(anchors.iter().map(|a| num_at(a, "exemptAmount")));
            let resale = sum_money(
                anchors
                    .iter()
                    .filter(|a| text(a, "exemptReason") == Some("resale"))
                    .map(|a| num_at(a, "exemptAmount")),
            );
            let non_taxable = sum_money(anchors.iter().map(|a| num_at(a, "nonTaxableAmount")));
            docs.push(NexusDocument {
                date: s(anchors[0], "taxDate").to_owned(),
                state_code,
                gross,
                taxable: round2(gross - exempt - non_taxable),
                retail: round2(gross - resale),
                marketplace_facilitated: anchors
                    .iter()
                    .any(|a| a["marketplaceFacilitated"].as_bool() == Some(true)),
            });
        }
    }

    for i in bare_invoices(db, entity_id, &from, as_of).await? {
        let null = Value::Null;
        let shipping = state_of_address(i.shipping_address.as_ref().unwrap_or(&null));
        let state_code = if shipping.is_empty() {
            state_of_address(i.billing_address.as_ref().unwrap_or(&null))
        } else {
            shipping
        };
        if state_code.is_empty() {
            continue;
        }
        let sign = if i.kind == "credit_note" { -1.0 } else { 1.0 };
        let amount = round2(decimal_num(i.subtotal.as_ref()) * sign);
        docs.push(NexusDocument {
            // `to_char(issue_date, 'YYYY-MM-DD')`.
            date: day_text(i.issue_date.date()),
            state_code,
            gross: amount,
            taxable: amount,
            retail: amount,
            marketplace_facilitated: i.marketplace_facilitated == Some(true),
        });
    }
    Ok(docs)
}

/// A posted invoice that wrote no tax-ledger rows.
#[derive(Debug, sea_orm::FromQueryResult)]
struct BareInvoice {
    /// `type`.
    kind: String,
    issue_date: time::PrimitiveDateTime,
    subtotal: Option<BigDecimal>,
    shipping_address: Option<Value>,
    billing_address: Option<Value>,
    marketplace_facilitated: Option<bool>,
}

/// The entity's posted invoices, credit notes and corrections issued from
/// `from` through `as_of` that have no `tax_lines` rows (`not exists`).
async fn bare_invoices(
    db: &PgPool,
    entity_id: &str,
    from: &str,
    as_of: &str,
) -> Result<Vec<BareInvoice>, DbErr> {
    use invoices::Column;
    use sea_orm::ExprTrait as _;
    let ledger = SqlQuery::select()
        .expr(Expr::val(1))
        .from(tax_lines::Entity)
        .and_where(
            Expr::col((tax_lines::Entity, tax_lines::Column::SourceId))
                .equals((invoices::Entity, Column::Id)),
        )
        .and_where(tax_lines::Column::SourceType.is_in(["invoice", "credit_note"]))
        .to_owned();
    invoices::Entity::find()
        .select_only()
        .column_as(Column::Type, "kind")
        .columns([
            Column::IssueDate,
            Column::Subtotal,
            Column::ShippingAddress,
            Column::BillingAddress,
            Column::MarketplaceFacilitated,
        ])
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Type.is_in(["standard", "correction", "credit_note"]))
        .filter(Column::JournalEntryId.is_not_null())
        .filter(Column::IssueDate.gte(day_start(from)?))
        .filter(Column::IssueDate.lte(day_start(&next_day(as_of))?))
        .filter(Expr::not_exists(ledger))
        .into_model::<BareInvoice>()
        .all(&orm(db))
        .await
}

fn base_amount(rule: &NexusRule, d: &NexusDocument) -> f64 {
    match rule.base.as_str() {
        "gross" => d.gross,
        "retail" => d.retail,
        _ => d.taxable,
    }
}

/// `salesForRule(rule, docs)`: the amount of the rule's base, one sale per
/// document.
fn sales_for_rule(rule: &NexusRule, docs: &[NexusDocument]) -> Vec<NexusSale> {
    docs.iter()
        .filter(|d| d.state_code == rule.state_code)
        .map(|d| NexusSale {
            date: d.date.clone(),
            amount: base_amount(rule, d),
            state_code: d.state_code.clone(),
            marketplace_facilitated: d.marketplace_facilitated,
            taxable: true,
            retail: true,
        })
        .collect()
}

fn agency_for<'a>(agencies: &'a [Value], state_code: &str) -> Option<&'a Value> {
    agencies
        .iter()
        .find(|a| s(a, "stateCode").to_uppercase() == state_code && s(a, "status") == "registered")
        .or_else(|| {
            agencies
                .iter()
                .find(|a| s(a, "stateCode").to_uppercase() == state_code)
        })
}

/// `measure(code, docs, asOf, agencies)`: a monitor row as JSON and its
/// percent of the threshold.
fn measure(
    code: &str,
    docs: &[NexusDocument],
    as_of: &str,
    agencies: &[Value],
) -> Option<(Map<String, Value>, f64, String)> {
    let rule = get_nexus_rule(code, as_of).filter(|r| r.has_sales_tax)?;
    let registered = if registered_on(agencies, Some(code), as_of) {
        vec![code.to_owned()]
    } else {
        Vec::new()
    };
    let row = nexus_monitor(
        &[code.to_owned()],
        &sales_for_rule(rule, docs),
        as_of,
        &registered,
    )
    .into_iter()
    .next()?;
    let agency = agency_for(agencies, code);
    let percent = row.measurement.percent_of_threshold;
    let state_code = row.measurement.state_code.clone();
    let mut out = row.to_json();
    out.insert(
        "agencyId".into(),
        agency.map_or(Value::Null, |a| a["id"].clone()),
    );
    out.insert(
        "agencyStatus".into(),
        agency.map_or(Value::Null, |a| a["status"].clone()),
    );
    out.insert("base".into(), json!(rule.base));
    out.insert("comparison".into(), json!(rule.comparison));
    out.insert("test".into(), json!(rule.test));
    out.insert("sourceUrl".into(), json!(rule.source_url));
    out.insert("ruleNotes".into(), json!(rule.notes));
    Some((out, percent, state_code))
}

/// `nexusOverview(db, entity, asOf)`.
pub(crate) async fn nexus_overview(
    db: &PgPool,
    entity_id: &str,
    as_of: &str,
) -> Result<Value, DbErr> {
    let docs = load_nexus_documents(db, entity_id, as_of).await?;
    let agencies = load_agencies(db, entity_id).await?;
    let mut rows: Vec<(Map<String, Value>, f64, String)> = nexus_monitored_codes()
        .iter()
        .filter_map(|code| measure(code, &docs, as_of, &agencies))
        .collect();
    rows.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| locale_compare(&a.2, &b.2)));
    let count = |alert: &str| {
        rows.iter()
            .filter(|(r, _, _)| r["alert"].as_str() == Some(alert))
            .count()
    };
    let summary = json!({
        "exceededUnregistered": count("register"),
        "approaching": count("watch"),
        "exceededRegistered": count("registered"),
        "monitored": rows.len(),
    });
    let rows: Vec<Value> = rows.into_iter().map(|(r, _, _)| Value::Object(r)).collect();
    Ok(json!({ "asOf": as_of, "rows": rows, "summary": summary }))
}

/// `nexusDetail(db, entity, stateCode, asOf)`: one state with the months of
/// sales behind the measurement.
pub(crate) async fn nexus_detail(
    db: &PgPool,
    entity_id: &str,
    state_code: &str,
    as_of: &str,
) -> Result<Option<Value>, DbErr> {
    let code = weldsuite_kit::validation::js_trim(state_code).to_uppercase();
    let docs = load_nexus_documents(db, entity_id, as_of).await?;
    let agencies = load_agencies(db, entity_id).await?;
    let Some((mut row, _, _)) = measure(&code, &docs, as_of, &agencies) else {
        return Ok(None);
    };
    let Some(rule) = get_nexus_rule(&code, as_of) else {
        return Ok(None);
    };
    let state_docs: Vec<&NexusDocument> = docs.iter().filter(|d| d.state_code == code).collect();
    let periods = row["periods"].as_array().cloned().unwrap_or_default();
    let mut starts: Vec<String> = periods.iter().map(|p| s(p, "from").to_owned()).collect();
    starts.sort();
    let mut ends: Vec<String> = periods.iter().map(|p| s(p, "to").to_owned()).collect();
    ends.sort();
    let from = starts
        .first()
        .cloned()
        .unwrap_or_else(|| s(&row["window"], "from").to_owned());
    let to = ends
        .last()
        .cloned()
        .unwrap_or_else(|| s(&row["window"], "to").to_owned());
    let mut monthly: Vec<Value> = Vec::new();
    let mut month = weldsuite_books_domain::dates::start_of_month(&from).unwrap_or_default();
    while !month.is_empty() && month <= to {
        let end = weldsuite_books_domain::dates::end_of_month(&month).unwrap_or_default();
        let in_month: Vec<&&NexusDocument> = state_docs
            .iter()
            .filter(|d| d.date >= month && d.date <= end)
            .collect();
        let counted: Vec<&&&NexusDocument> = in_month
            .iter()
            .filter(|d| !d.marketplace_facilitated || rule.marketplace_sales_count)
            .collect();
        monthly.push(json!({
            "month": month.get(..7).unwrap_or(""),
            "sales": n(sum_money(counted.iter().map(|d| base_amount(rule, d)))),
            "gross": n(sum_money(in_month.iter().map(|d| d.gross))),
            "taxable": n(sum_money(in_month.iter().map(|d| d.taxable))),
            "transactions": counted.iter().filter(|d| base_amount(rule, d) > 0.0).count(),
            "marketplaceSales": n(sum_money(in_month.iter().filter(|d| d.marketplace_facilitated).map(|d| d.gross))),
        }));
        month = add_months(&month, 1);
    }
    row.insert(
        "rule".into(),
        json!({
            "effectiveFrom": rule.effective_from,
            "salesThreshold": rule.sales_threshold.map(n),
            "transactionThreshold": rule.transaction_threshold.map(n),
            "test": rule.test,
            "comparison": rule.comparison,
            "base": rule.base,
            "window": rule.window,
            "marketplaceSalesCount": rule.marketplace_sales_count,
        }),
    );
    row.insert("monthly".into(), Value::Array(monthly));
    Ok(Some(Value::Object(row)))
}

/// `asOfOf(c)`: a given `asOf` must be a date.
fn as_of_of(q: &Query) -> Result<Option<String>, Refusal> {
    match q.get("asOf") {
        Some(as_of) if !as_of.is_empty() && !is_iso_date_text(as_of) => {
            Err(bad("asOf must be a YYYY-MM-DD date"))
        }
        other => Ok(other.map(str::to_owned)),
    }
}

/// The day measured: the given one, or today in the entity's zone. An empty
/// `asOf` (`""`, not a date) fails in the database, as TypeScript's does.
fn day_of(
    caller: &Caller,
    state: &BooksState,
    entity: &Value,
    as_of: Option<String>,
) -> Result<String, Refusal> {
    match as_of {
        Some(day) if !weldsuite_books_domain::dates::is_iso_date(&day) => {
            Err(Refusal::Internal(format!("invalid asOf {day}")))
        }
        Some(day) => Ok(day),
        None => Ok(today_in(caller, state, text(entity, "timezone"))),
    }
}

async fn overview(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let as_of = as_of_of(&q)?;
            let entity = us_entity_of(&caller).await?;
            let day = day_of(&caller, &state, &entity, as_of)?;
            Ok(ok(nexus_overview(&caller.db, s(&entity, "id"), &day).await?))
        }
        .await,
        "Failed to fetch the nexus monitor",
    )
}

async fn detail(
    caller: Caller,
    State(state): State<BooksState>,
    Path(code): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let as_of = as_of_of(&q)?;
            let entity = us_entity_of(&caller).await?;
            let day = day_of(&caller, &state, &entity, as_of)?;
            match nexus_detail(&caller.db, s(&entity, "id"), &code, &day).await? {
                Some(detail) => Ok(ok(detail)),
                None => Ok((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": {
                        "code": "NOT_FOUND",
                        "message": format!("{} has no sales tax to monitor", code.to_uppercase()),
                    } })),
                )
                    .into_response()),
            }
        }
        .await,
        "Failed to fetch the nexus detail",
    )
}
