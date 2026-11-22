//! Filing a return, and what happens to a filed period afterwards
//! (`services/sales-tax-returns/filing.ts`).
//!
//! Filing stamps every ledger row the worksheet counted with the return's id
//! in the same transaction that marks it filed. A change to a filed period
//! shows as an exception (an unstamped row dated in the period, posted after
//! filing); the user amends the return or carries the rows forward, and the
//! choice is recorded per row on the filed return's `exceptions`.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::locale_compare;
use weldsuite_books_domain::tables::TAX_RETURNS;
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{tax_lines, tax_returns};

use super::calculate::{Calculation, CalculationInput, calculate_return, same_worksheet};
use super::common::{
    FILED_STATUSES, add_months, bad, bad_with, conflict, day_text, is_filed, n, num_at, parse_day,
    parse_instant, reporting_basis_of, return_by_id, rows_json, s, sum_money,
};
use super::documents::{describe_documents, document_key};
use super::lifecycle::RETURN_ROWS;
use super::periods::build_period_rows;
use super::rows::{LoadedRows, ReceivedFilter, received_by_invoice, rows_by_ids};
use crate::common::text;
use crate::orm_bridge::refusal;
use weldsuite_books_domain::http::Refusal;

/// The statements that stamp the rows a return counted with its id, run on
/// `conn`. Rows another return stamped stay as they are.
async fn stamp_rows(
    conn: &OrmConn<'_>,
    entity_id: &str,
    agency: &Value,
    ret: &Value,
    rows: &LoadedRows,
    cutoff: &str,
) -> Result<(), DbErr> {
    use tax_lines::Column;
    let return_id = s(ret, "id");
    if reporting_basis_of(agency) == "cash" {
        return stamp_ids(conn, return_id, &rows.settled_ids).await;
    }
    tax_lines::Entity::update_many()
        .col_expr(Column::TaxReturnId, Expr::value(return_id))
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::AgencyId.eq(s(agency, "id")))
        .filter(Column::TaxDate.gte(parse_day(s(ret, "periodStart"))?))
        .filter(Column::TaxDate.lte(parse_day(s(ret, "periodEnd"))?))
        .filter(Column::Direction.is_in(["sales", "use"]))
        .filter(Column::TaxReturnId.is_null())
        .filter(Column::CreatedAt.lte(parse_instant(cutoff)?))
        .exec(conn)
        .await?;
    stamp_ids(conn, return_id, &rows.carried_ids).await
}

async fn stamp_ids(conn: &OrmConn<'_>, return_id: &str, ids: &[String]) -> Result<(), DbErr> {
    use tax_lines::Column;
    for part in ids.chunks(2000) {
        tax_lines::Entity::update_many()
            .col_expr(Column::TaxReturnId, Expr::value(return_id))
            .filter(Column::Id.is_in(part.iter().map(String::as_str)))
            .filter(Column::TaxReturnId.is_null())
            .exec(conn)
            .await?;
    }
    Ok(())
}

/// The return marked filed (while it is still calculated or reviewed), then
/// the rows it counted stamped with its id: one transaction.
async fn mark_filed(
    conn: &OrmConn<'_>,
    input: &FileInput<'_>,
    calc: &Calculation,
    filed_at: &str,
) -> Result<(), DbErr> {
    use tax_returns::Column;
    let ret = input.ret;
    tax_returns::Entity::update_many()
        .col_expr(Column::Status, Expr::value("filed"))
        .col_expr(Column::FiledAt, Expr::value(parse_instant(filed_at)?))
        .col_expr(
            Column::FiledBy,
            Expr::value(input.user_id.map(str::to_owned)),
        )
        .col_expr(
            Column::ConfirmationNumber,
            Expr::value(weldsuite_kit::validation::js_trim(
                input.confirmation_number,
            )),
        )
        .col_expr(Column::UpdatedAt, Expr::value(parse_instant(input.now)?))
        .filter(Column::Id.eq(s(ret, "id")))
        .filter(Column::Status.is_in(["calculated", "reviewed"]))
        .exec(conn)
        .await?;
    stamp_rows(
        conn,
        s(ret, "entityId"),
        input.agency,
        ret,
        &calc.rows,
        input.now,
    )
    .await
}

/// `exceptions` of a return set, with `updated_at`.
async fn set_exceptions(
    conn: &impl sea_orm::ConnectionTrait,
    return_id: &str,
    exceptions: Vec<Value>,
    now: &str,
) -> Result<(), DbErr> {
    use tax_returns::Column;
    tax_returns::Entity::update_many()
        .col_expr(Column::Exceptions, Expr::value(Value::Array(exceptions)))
        .col_expr(Column::UpdatedAt, Expr::value(parse_instant(now)?))
        .filter(Column::Id.eq(return_id))
        .exec(conn)
        .await?;
    Ok(())
}

/// `FileInput`.
pub(crate) struct FileInput<'a> {
    pub entity: &'a Value,
    pub agency: &'a Value,
    pub ret: &'a Value,
    pub confirmation_number: &'a str,
    /// `filedAt.toISOString()`, when given.
    pub filed_at: Option<String>,
    pub user_id: Option<&'a str>,
    pub now: &'a str,
    pub today: &'a str,
}

/// `fileReturn(db, input)`: the filed return and its warnings.
#[allow(clippy::too_many_lines, reason = "mirrors filing.ts's fileReturn()")]
pub(crate) async fn file_return(
    db: &PgPool,
    input: FileInput<'_>,
) -> Result<(Value, Vec<Value>), Refusal> {
    let FileInput {
        entity,
        agency,
        ret,
        now,
        ..
    } = input;
    let status = s(ret, "status");
    if status == "open" {
        return Err(bad("Calculate the return before filing it"));
    }
    if FILED_STATUSES.contains(&status) {
        return Err(conflict("This return has already been filed"));
    }
    if !matches!(status, "calculated" | "reviewed") {
        return Err(bad(format!("A {status} return cannot be filed")));
    }
    let filed_at = input.filed_at.clone().unwrap_or_else(|| now.to_owned());
    let filed_day = filed_at.get(..10).unwrap_or(&filed_at).to_owned();
    if filed_day.as_str() < s(ret, "periodEnd") {
        return Err(bad("A return cannot be filed before its period has ended"));
    }
    let calc = calculate_return(
        db,
        &CalculationInput {
            entity,
            agency,
            ret,
            now,
            today: input.today,
            created_not_after: Some(now),
        },
    )
    .await
    .map_err(refusal)?;
    if !same_worksheet(&ret["summary"], &calc.summary) {
        return Err(conflict(
            "The ledger changed since this return was calculated. Recalculate it, review the worksheet and file again.",
        ));
    }

    let mut tx = db.begin().await?;
    mark_filed(&OrmConn::new(&mut tx), &input, &calc, &filed_at)
        .await
        .map_err(refusal)?;
    tx.commit().await?;
    let updated = return_by_id(db, s(ret, "id")).await.map_err(refusal)?;
    let Some(updated) = updated.filter(|u| s(u, "status") == "filed" && !u["filedAt"].is_null())
    else {
        return Err(conflict(
            "This return was changed while filing; reload it and try again",
        ));
    };

    let mut warnings: Vec<Value> = Vec::new();
    let due = text(ret, "dueDate").filter(|d| !d.is_empty());
    let timely = due.is_none_or(|d| filed_day.as_str() <= d);
    if !timely {
        warnings.push(json!({
            "code": "late_filing",
            "message": format!(
                "Filed after the due date ({}). Penalty and interest may apply; add them as adjustments before recording the payment.",
                due.unwrap_or("")
            ),
        }));
        if super::common::adjustments_of(ret)
            .iter()
            .any(|a| text(a, "type") == Some("vendor_discount"))
        {
            warnings.push(json!({
                "code": "vendor_discount_late",
                "message": "The vendor discount only holds when the return is filed and paid on time. Remove it unless the state still allows it.",
            }));
        }
    }
    let returns = super::common::load_agency_returns(db, s(ret, "entityId"), s(agency, "id"))
        .await
        .map_err(refusal)?;
    let from = add_months(s(ret, "periodStart"), -24);
    let unfiled: Vec<String> = build_period_rows(
        agency,
        &returns,
        &from,
        &add_months(s(ret, "periodStart"), 0),
        input.today,
    )
    .into_iter()
    .filter(|p| p.period.period_end.as_str() < s(ret, "periodStart") && p.unfiled)
    .map(|p| p.period.period_end)
    .collect();
    if !unfiled.is_empty() {
        warnings.push(json!({
            "code": "earlier_period_unfiled",
            "message": format!(
                "Earlier period(s) of this agency have no filed return: {}.",
                unfiled.join(", ")
            ),
        }));
    }
    Ok((updated, warnings))
}

// ── Exceptions ──────────────────────────────────────────────────────────────

/// `storedExceptions(ret)`: `(taxLineId, resolution, amendedByReturnId)`.
fn stored_exceptions(ret: &Value) -> Vec<(String, String, Option<String>)> {
    ret["exceptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| {
            text(e, "type") == Some("late_entry")
                && e["taxLineId"].is_string()
                && matches!(text(e, "resolution"), Some("carried_forward" | "amended"))
        })
        .map(|e| {
            (
                s(e, "taxLineId").to_owned(),
                s(e, "resolution").to_owned(),
                text(e, "amendedByReturnId").map(str::to_owned),
            )
        })
        .collect()
}

async fn is_latest_in_chain(db: &PgPool, ret: &Value) -> Result<bool, DbErr> {
    use tax_returns::Column;
    let later: Option<String> = tax_returns::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::EntityId.eq(s(ret, "entityId")))
        .filter(Column::AmendsReturnId.eq(s(ret, "id")))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.is_in(FILED_STATUSES))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(later.is_none())
}

async fn live_exception_rows(
    db: &PgPool,
    agency: &Value,
    ret: &Value,
) -> Result<Vec<Value>, DbErr> {
    use tax_lines::Column;
    let Some(filed_at) = text(ret, "filedAt").filter(|f| !f.is_empty()) else {
        return Ok(Vec::new());
    };
    if !is_latest_in_chain(db, ret).await? {
        return Ok(Vec::new());
    }
    let mut select = tax_lines::Entity::find()
        .filter(Column::EntityId.eq(s(ret, "entityId")))
        .filter(Column::AgencyId.eq(s(agency, "id")))
        .filter(Column::TaxDate.gte(parse_day(s(ret, "periodStart"))?))
        .filter(Column::TaxDate.lte(parse_day(s(ret, "periodEnd"))?))
        .filter(Column::Direction.is_in(["sales", "use"]))
        .filter(Column::TaxReturnId.is_null())
        .filter(Column::CreatedAt.gt(parse_instant(filed_at)?));
    if reporting_basis_of(agency) == "cash" {
        select = select.filter(Column::SourceType.ne("invoice"));
    }
    rows_json(select.all(&orm(db)).await?)
}

/// An exception item (`ExceptionItem`), with the fields the actions read.
pub(crate) struct ExceptionItem {
    pub json: Value,
    pub tax_line_ids: Vec<String>,
    pub resolution: String,
    pub tax_amount: f64,
    pub counted_by: Option<String>,
}

/// `ExceptionsResult`.
pub(crate) struct Exceptions {
    pub applicable: bool,
    pub items: Vec<ExceptionItem>,
    pub late_payments: Vec<Value>,
    pub totals: Value,
}

impl Exceptions {
    pub(crate) fn to_json(&self, return_id: &str) -> Value {
        json!({
            "returnId": return_id,
            "applicable": self.applicable,
            "items": self.items.iter().map(|i| i.json.clone()).collect::<Vec<_>>(),
            "latePayments": self.late_payments,
            "totals": self.totals,
        })
    }
}

fn empty_totals() -> Value {
    json!({
        "open": { "documents": 0, "taxAmount": 0 },
        "carried_forward": { "documents": 0, "taxAmount": 0 },
        "amended": { "documents": 0, "taxAmount": 0 },
    })
}

/// `listExceptions(db, { entity, agency, ret })`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors filing.ts's listExceptions()"
)]
pub(crate) async fn list_exceptions(
    db: &PgPool,
    agency: &Value,
    ret: &Value,
) -> Result<Exceptions, DbErr> {
    if !is_filed(ret) {
        return Ok(Exceptions {
            applicable: false,
            items: Vec::new(),
            late_payments: Vec::new(),
            totals: empty_totals(),
        });
    }
    let stored = stored_exceptions(ret);
    // `new Map(...)`: the last entry of a row wins.
    let stored_of = |id: &str| stored.iter().rev().find(|(t, _, _)| t == id);
    let live = live_exception_rows(db, agency, ret).await?;
    let mut missing: Vec<String> = Vec::new();
    for (id, _, _) in &stored {
        if !live.iter().any(|r| s(r, "id") == id) && !missing.contains(id) {
            missing.push(id.clone());
        }
    }
    let stored_rows = rows_by_ids(db, &missing).await?;
    let rows: Vec<Value> = live.into_iter().chain(stored_rows).collect();
    let refs: Vec<&Value> = rows.iter().collect();
    let docs = describe_documents(db, s(ret, "entityId"), &refs).await?;

    let mut by_doc: Vec<(String, Vec<&Value>)> = Vec::new();
    for row in &rows {
        let key = document_key(row);
        match by_doc.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(row),
            None => by_doc.push((key, vec![row])),
        }
    }
    let mut items: Vec<(String, String, ExceptionItem)> = Vec::new();
    for (key, list) in by_doc {
        let mut resolutions: Vec<String> = Vec::new();
        for r in &list {
            let resolution =
                stored_of(s(r, "id")).map_or_else(|| "open".to_owned(), |(_, res, _)| res.clone());
            if !resolutions.contains(&resolution) {
                resolutions.push(resolution);
            }
        }
        let info = docs.get(&key).cloned().unwrap_or(Value::Null);
        let amended = list.iter().find_map(|r| {
            stored_of(s(r, "id"))
                .and_then(|(_, _, a)| a.clone())
                .filter(|a| !a.is_empty())
        });
        let counted = list.iter().find(|r| {
            text(r, "taxReturnId").is_some_and(|t| !t.is_empty() && t != s(ret, "id"))
                && stored_of(s(r, "id")).is_some_and(|(_, res, _)| res == "carried_forward")
        });
        let counted_by = counted
            .and_then(|r| text(r, "taxReturnId"))
            .map(str::to_owned);
        let posted_at = list
            .iter()
            .map(|r| s(r, "createdAt"))
            .fold(
                s(list[0], "createdAt"),
                |latest, c| if c > latest { c } else { latest },
            )
            .to_owned();
        let tax_amount = sum_money(list.iter().map(|r| num_at(r, "taxAmount")));
        let resolution = if resolutions.len() == 1 {
            resolutions[0].clone()
        } else {
            "partial".to_owned()
        };
        let tax_line_ids: Vec<String> = list.iter().map(|r| s(r, "id").to_owned()).collect();
        let tax_date = s(list[0], "taxDate").to_owned();
        let json = json!({
            "key": key,
            "document": {
                "type": info["type"],
                "id": info["id"],
                "number": info["number"],
                "contactName": info["contactName"],
                "date": info["date"],
            },
            "taxDate": tax_date,
            "postedAt": posted_at,
            "taxLineIds": tax_line_ids,
            "grossAmount": n(sum_money(list.iter().filter(|r| !r["grossAmount"].is_null()).map(|r| num_at(r, "grossAmount")))),
            "taxableAmount": n(sum_money(list.iter().map(|r| num_at(r, "taxableAmount")))),
            "taxAmount": n(tax_amount),
            "resolution": resolution,
            "amendedByReturnId": amended,
            "countedByReturnId": counted_by,
        });
        items.push((
            tax_date,
            key,
            ExceptionItem {
                json,
                tax_line_ids,
                resolution,
                tax_amount,
                counted_by,
            },
        ));
    }
    items.sort_by(|a, b| locale_compare(&a.0, &b.0).then_with(|| locale_compare(&a.1, &b.1)));
    let items: Vec<ExceptionItem> = items.into_iter().map(|(_, _, i)| i).collect();

    let mut totals: Vec<(&str, i64, f64)> = vec![
        ("open", 0, 0.0),
        ("carried_forward", 0, 0.0),
        ("amended", 0, 0.0),
    ];
    for item in &items {
        let bucket = if item.resolution == "partial" {
            "open"
        } else {
            item.resolution.as_str()
        };
        if let Some(t) = totals.iter_mut().find(|(k, _, _)| *k == bucket) {
            t.1 += 1;
            t.2 = sum_money([t.2, item.tax_amount]);
        }
    }
    let totals = Value::Object(
        totals
            .into_iter()
            .map(|(k, docs, tax)| {
                (
                    k.to_owned(),
                    json!({ "documents": docs, "taxAmount": n(tax) }),
                )
            })
            .collect::<Map<String, Value>>(),
    );
    let late_payments = if reporting_basis_of(agency) == "cash" {
        late_payments(db, ret).await?
    } else {
        Vec::new()
    };
    Ok(Exceptions {
        applicable: true,
        items,
        late_payments,
        totals,
    })
}

async fn late_payments(db: &PgPool, ret: &Value) -> Result<Vec<Value>, DbErr> {
    let Some(filed_at) = text(ret, "filedAt").filter(|f| !f.is_empty()) else {
        return Ok(Vec::new());
    };
    let late = received_by_invoice(
        db,
        s(ret, "entityId"),
        &ReceivedFilter {
            from: Some(super::common::start_of_day(s(ret, "periodStart"))),
            before: Some(super::common::start_of_day(&super::common::next_day(s(
                ret,
                "periodEnd",
            )))),
            created_after: Some(filed_at.to_owned()),
            ..ReceivedFilter::default()
        },
    )
    .await?;
    if late.is_empty() {
        return Ok(Vec::new());
    }
    let pseudo: Vec<Value> = late
        .iter()
        .map(|(id, _)| json!({ "sourceType": "invoice", "sourceId": id, "journalEntryId": id }))
        .collect();
    let refs: Vec<&Value> = pseudo.iter().collect();
    let docs = describe_documents(db, s(ret, "entityId"), &refs).await?;
    Ok(late
        .iter()
        .map(|(id, amount)| {
            let info = docs.get(&format!("invoice|{id}"));
            json!({
                "invoiceId": id,
                "invoiceNumber": info.map_or(Value::Null, |i| i["number"].clone()),
                "contactName": info.map_or(Value::Null, |i| i["contactName"].clone()),
                "amount": n(*amount),
            })
        })
        .collect())
}

fn open_row_ids(result: &Exceptions) -> Vec<String> {
    result
        .items
        .iter()
        .filter(|i| i.resolution == "open" || i.resolution == "partial")
        .flat_map(|i| i.tax_line_ids.iter().cloned())
        .collect()
}

/// `withResolutions(ret, ids, resolution, userId, now, amendedByReturnId)`.
fn with_resolutions(
    ret: &Value,
    ids: &[String],
    resolution: &str,
    user_id: Option<&str>,
    now: &str,
    amended_by: Option<&str>,
) -> Vec<Value> {
    let mut out: Vec<Value> = ret["exceptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| {
            !(text(e, "type") == Some("late_entry")
                && text(e, "taxLineId").is_some_and(|t| ids.iter().any(|i| i == t)))
        })
        .cloned()
        .collect();
    for id in ids {
        let mut entry = json!({
            "type": "late_entry",
            "taxLineId": id,
            "resolution": resolution,
            "resolvedAt": now,
            "resolvedBy": user_id,
        });
        if let Some(by) = amended_by.filter(|b| !b.is_empty()) {
            entry["amendedByReturnId"] = json!(by);
        }
        out.push(entry);
    }
    out
}

/// `carryForward(...)`: the updated return, rows carried, their tax, and
/// later returns to recalculate.
pub(crate) async fn carry_forward(
    db: &PgPool,
    agency: &Value,
    ret: &Value,
    tax_line_ids: Option<Vec<String>>,
    user_id: Option<&str>,
    now: &str,
) -> Result<(Value, usize, f64, Vec<Value>), Refusal> {
    if !is_filed(ret) {
        return Err(bad("Only a filed return has exceptions to carry forward"));
    }
    let result = list_exceptions(db, agency, ret).await.map_err(refusal)?;
    let open = open_row_ids(&result);
    let mut ids: Vec<String> = Vec::new();
    for id in tax_line_ids
        .filter(|given| !given.is_empty())
        .unwrap_or_else(|| open.clone())
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let unknown: Vec<&String> = ids.iter().filter(|id| !open.contains(id)).collect();
    if !unknown.is_empty() {
        return Err(bad_with(
            "Some rows are not open exceptions of this return",
            json!({ "taxLineIds": unknown }),
        ));
    }
    if ids.is_empty() {
        return Err(bad("This return has no open exceptions to carry forward"));
    }
    let exceptions = with_resolutions(ret, &ids, "carried_forward", user_id, now, None);
    set_exceptions(&orm(db), s(ret, "id"), exceptions, now)
        .await
        .map_err(refusal)?;
    let updated = return_by_id(db, s(ret, "id"))
        .await
        .map_err(refusal)?
        .unwrap_or_else(|| ret.clone());
    let tax_amount = sum_money(
        result
            .items
            .iter()
            .filter(|i| i.tax_line_ids.iter().any(|id| ids.contains(id)))
            .map(|i| i.tax_amount),
    );
    let later = later_calculated(db, s(ret, "entityId"), s(agency, "id"), s(ret, "periodEnd"))
        .await
        .map_err(refusal)?;
    Ok((updated, ids.len(), tax_amount, later))
}

/// A later return to recalculate.
#[derive(Debug, FromQueryResult)]
struct LaterReturn {
    id: String,
    status: String,
    period_end: time::Date,
}

/// The agency's calculated or reviewed returns of periods starting after
/// `period_end`, as `{ id, status, periodEnd }`.
async fn later_calculated(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
    period_end: &str,
) -> Result<Vec<Value>, DbErr> {
    use tax_returns::Column;
    let rows = tax_returns::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Status, Column::PeriodEnd])
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::AgencyId.eq(agency_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::PeriodStart.gt(parse_day(period_end)?))
        .filter(Column::Status.is_in(["calculated", "reviewed"]))
        .into_model::<LaterReturn>()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| json!({ "id": r.id, "status": r.status, "periodEnd": day_text(r.period_end) }))
        .collect())
}

/// `amendReturn(...)`: the new return and how many exception rows moved into it.
#[allow(clippy::too_many_lines, reason = "mirrors filing.ts's amendReturn()")]
pub(crate) async fn amend_return(
    db: &PgPool,
    entity: &Value,
    agency: &Value,
    ret: &Value,
    user_id: Option<&str>,
    now: &str,
    today: &str,
) -> Result<(Value, usize), Refusal> {
    if !is_filed(ret) {
        return Err(bad("Only a filed return can be amended"));
    }
    let existing: Option<(String, String)> = tax_returns::Entity::find()
        .select_only()
        .columns([tax_returns::Column::Id, tax_returns::Column::Status])
        .filter(tax_returns::Column::AmendsReturnId.eq(s(ret, "id")))
        .filter(tax_returns::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(refusal)?;
    if let Some((id, status)) = existing {
        return Err(conflict(if FILED_STATUSES.contains(&status.as_str()) {
            format!("This return was already amended by {id}; amend that return instead")
        } else {
            format!("An amended return ({id}) is already open for this period")
        }));
    }
    let exceptions = list_exceptions(db, agency, ret).await.map_err(refusal)?;
    let take_ids: Vec<String> = exceptions
        .items
        .iter()
        .filter(|i| i.resolution != "amended" && i.counted_by.is_none())
        .flat_map(|i| i.tax_line_ids.iter().cloned())
        .collect();

    let id = generate_id("txr");
    let draft = json!({
        "id": id,
        "createdAt": now,
        "updatedAt": now,
        "deletedAt": null,
        "entityId": ret["entityId"],
        "jurisdictionCode": ret["jurisdictionCode"],
        "agencyId": ret["agencyId"],
        "stateCode": ret["stateCode"],
        "periodStart": ret["periodStart"],
        "periodEnd": ret["periodEnd"],
        "dueDate": ret["dueDate"],
        "status": "open",
        "reportingBasis": ret["reportingBasis"],
        "summary": null,
        "lines": null,
        "adjustments": null,
        "exceptions": null,
        "totalDue": "0",
        "filedAt": null,
        "filedBy": null,
        "confirmationNumber": null,
        "paidAt": null,
        "paymentAmount": null,
        "paymentBankAccountId": null,
        "paymentJournalEntryId": null,
        "amendsReturnId": ret["id"],
        "notes": null,
    });
    let calculation: Calculation = calculate_return(
        db,
        &CalculationInput {
            entity,
            agency,
            ret: &draft,
            now,
            today,
            created_not_after: None,
        },
    )
    .await
    .map_err(refusal)?;
    if take_ids.is_empty() && same_worksheet(&ret["summary"], &calculation.summary) {
        return Err(bad(
            "Nothing to amend: the ledger still matches the filed return",
        ));
    }
    let mut values = Map::new();
    for column in TAX_RETURNS.columns {
        if let Some(value) = draft.get(column.prop) {
            values.insert(column.name.to_owned(), value.clone());
        }
    }
    values.insert("status".into(), json!("calculated"));
    values.insert("summary".into(), calculation.summary.clone());
    values.insert("lines".into(), Value::Array(calculation.lines.clone()));
    values.insert(
        "adjustments".into(),
        Value::Array(calculation.adjustments.clone()),
    );
    values.insert(
        "total_due".into(),
        json!(weldsuite_books_domain::js::to_fixed(
            calculation.total_due,
            2
        )),
    );
    let mut tx = db.begin().await?;
    {
        let conn = OrmConn::new(&mut tx);
        RETURN_ROWS.insert(&conn, values).await.map_err(refusal)?;
        if !take_ids.is_empty() {
            let marked = with_resolutions(ret, &take_ids, "amended", user_id, now, Some(&id));
            set_exceptions(&conn, s(ret, "id"), marked, now)
                .await
                .map_err(refusal)?;
        }
    }
    tx.commit().await?;
    let created = return_by_id(db, &id)
        .await
        .map_err(refusal)?
        .unwrap_or(Value::Null);
    Ok((created, take_ids.len()))
}

/// `releaseAmendedExceptions(db, amendment)`: takes the "amended" marks of a
/// deleted amendment off the return it amended.
pub(crate) async fn release_amended_exceptions(
    db: &PgPool,
    amendment: &Value,
    now: &str,
) -> Result<(), DbErr> {
    let Some(original_id) = text(amendment, "amendsReturnId").filter(|a| !a.is_empty()) else {
        return Ok(());
    };
    let Some(original) = return_by_id(db, original_id).await? else {
        return Ok(());
    };
    let all: Vec<Value> = original["exceptions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let kept: Vec<Value> = all
        .iter()
        .filter(|e| {
            !(text(e, "type") == Some("late_entry")
                && text(e, "resolution") == Some("amended")
                && text(e, "amendedByReturnId") == text(amendment, "id"))
        })
        .cloned()
        .collect();
    if kept.len() == all.len() {
        return Ok(());
    }
    set_exceptions(&orm(db), s(&original, "id"), kept, now).await
}
