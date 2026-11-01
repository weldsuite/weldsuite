//! Small pieces the sales tax setup routes share
//! (`services/sales-tax/route-helpers.ts`): the entity of the request, paging,
//! date and percent checks.

use serde_json::Value;
use weldsuite_db::PgPool;

use super::errors::{SalesTaxError, SetupError};
use crate::entity_context::resolve_entity_id;
use crate::http::{Caller, Query};
use crate::tables::{ENTITIES, SALES_TAX_AGENCIES};

/// `new SalesTaxSetupError(message, status)`.
pub fn setup_error(message: impl Into<String>, status: u16) -> SalesTaxError {
    SalesTaxError::Setup(SetupError {
        message: message.into(),
        status,
    })
}

/// A setup route's failure: a refusal it answers itself, or the database.
#[derive(Debug)]
pub enum SetupFailure {
    Refused(SalesTaxError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for SetupFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<SalesTaxError> for SetupFailure {
    fn from(error: SalesTaxError) -> Self {
        Self::Refused(error)
    }
}

impl From<SetupFailure> for crate::http::Refusal {
    fn from(failure: SetupFailure) -> Self {
        match failure {
            SetupFailure::Refused(error) => Self::Response(Box::new(error.response())),
            SetupFailure::Database(error) => Self::Database(error),
        }
    }
}

/// `pageParams(c)`: `page` from 1, `pageSize` 1–200 (default 50).
pub fn page_params(q: &Query) -> (i64, i64, i64) {
    let parse = |key: &str, fallback: i64| {
        q.present(key)
            .and_then(crate::js::parse_int)
            .filter(|n| *n != 0)
            .unwrap_or(fallback)
    };
    let page = parse("page", 1).max(1);
    let page_size = parse("pageSize", 50).clamp(1, 200);
    (page, page_size, (page - 1) * page_size)
}

/// `requireEntityId(c, db)`: the accounting entity of the request.
pub async fn require_entity_id(caller: &Caller) -> Result<String, SetupFailure> {
    match resolve_entity_id(caller).await? {
        Some(id) => Ok(id),
        None => Err(setup_error(
            "No accounting entity resolved. Set X-Accounting-Entity-Id or configure a default entity.",
            400,
        )
        .into()),
    }
}

/// `requireSalesTaxEntity(c, db)`: the entity row (as Drizzle returns it),
/// and a check that its jurisdiction has sales tax at all.
pub async fn require_sales_tax_entity(caller: &Caller) -> Result<Value, SetupFailure> {
    let entity_id = require_entity_id(caller).await?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&entity_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(entity) = row.map(|r| ENTITIES.js(r)) else {
        return Err(setup_error(format!("Accounting entity {entity_id} not found"), 404).into());
    };
    let code = entity["jurisdictionCode"].as_str().unwrap_or("");
    if !super::document_tax::uses_sales_tax_code(code) {
        return Err(setup_error(
            "Sales tax is only available for United States accounting entities",
            400,
        )
        .into());
    }
    Ok(entity)
}

/// `optionalSalesTaxEntity(c, db)`: a tenant with no accounting entity yet
/// has simply nothing to list.
pub async fn optional_sales_tax_entity(caller: &Caller) -> Result<Option<Value>, SetupFailure> {
    if resolve_entity_id(caller).await?.is_none() {
        return Ok(None);
    }
    require_sales_tax_entity(caller).await.map(Some)
}

/// `requireAgency(db, entityId, agencyId)`: an agency of this entity, or a 404.
pub async fn require_agency(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
) -> Result<Value, SetupFailure> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(agency_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| SALES_TAX_AGENCIES.js(r))
        .ok_or_else(|| setup_error(format!("Sales tax agency {agency_id} not found"), 404).into())
}

/// `rangesOverlap(a, b)`: two inclusive date ranges overlap (an empty `to`
/// is open-ended).
pub fn ranges_overlap(a: (&str, Option<&str>), b: (&str, Option<&str>)) -> bool {
    let a_end = a.1.unwrap_or("9999-12-31");
    let b_end = b.1.unwrap_or("9999-12-31");
    a.0 <= b_end && b.0 <= a_end
}

/// `dayBefore(day)`.
pub fn day_before(day: &str) -> Option<String> {
    super::dates::add_days(day, -1)
}

/// `checkDateOrder(from, to, what)`.
pub fn check_date_order(from: &str, to: Option<&str>, what: &str) -> Result<(), SalesTaxError> {
    match to {
        Some(to) if !to.is_empty() && to < from => Err(setup_error(
            format!("The end date of {what} is before its start date"),
            400,
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_and_days() {
        assert!(ranges_overlap(
            ("2026-01-01", None),
            ("2027-01-01", Some("2027-02-01"))
        ));
        assert!(!ranges_overlap(
            ("2026-01-01", Some("2026-12-31")),
            ("2027-01-01", None)
        ));
        assert_eq!(day_before("2026-03-01").as_deref(), Some("2026-02-28"));
        assert!(check_date_order("2026-02-01", Some("2026-01-01"), "the rate").is_err());
        let q = Query::parse(Some("page=0&pageSize=500"));
        assert_eq!(page_params(&q), (1, 200, 0));
        let q = Query::parse(Some("page=3&pageSize=x"));
        assert_eq!(page_params(&q), (3, 50, 100));
    }
}
