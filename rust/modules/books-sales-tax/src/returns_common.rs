//! What the sales tax returns, the calendar and the reports share
//! (`services/sales-tax-returns/{common,context,periods}.ts`): return
//! statuses, the agency as a calendar input, loading agencies.

use serde_json::Value;
use weldsuite_books_domain::tables::SALES_TAX_AGENCIES;
use weldsuite_books_domain::tax_calendar::AgencyInput;
use weldsuite_db::PgPool;

use crate::common::text;

/// `FILED_STATUSES`.
pub(crate) const FILED_STATUSES: [&str; 2] = ["filed", "paid"];

/// `agencyToInput(agency)`: the agency as a calendar input (its periods).
pub(crate) fn agency_to_input(agency: &Value) -> AgencyInput {
    let frequency = text(agency, "filingFrequency").unwrap_or("");
    let due = agency["dueDay"].as_i64().filter(|d| *d != 0).unwrap_or(20);
    AgencyInput {
        id: text(agency, "id").unwrap_or_default().to_owned(),
        name: text(agency, "name").map(str::to_owned),
        state_code: text(agency, "stateCode").map(str::to_owned),
        filing_frequency: if ["monthly", "quarterly", "semiannual", "annual"].contains(&frequency) {
            frequency.to_owned()
        } else {
            "quarterly".to_owned()
        },
        due_day: Some(due.clamp(1, 31)),
        first_period_start: text(agency, "firstPeriodStart")
            .or_else(|| text(agency, "registeredFrom"))
            .map(str::to_owned),
        registered_until: text(agency, "registeredUntil").map(str::to_owned),
        status: Some("registered".to_owned()),
    }
}

/// `loadAgencies(db, entityId)`: the entity's live agencies by state and name.
pub(crate) async fn load_agencies(db: &PgPool, entity_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.entity_id = $1 and t.deleted_at is null \
         order by t.state_code, t.name"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(SALES_TAX_AGENCIES.js_rows(rows))
}
