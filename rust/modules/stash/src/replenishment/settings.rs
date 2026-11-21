//! The workspace's replenishment settings: the single `stash_settings` row
//! (id `default`), or its defaults while nobody has saved it.

use serde_json::{Value, json};
use sqlx::PgExecutor;
use time::Date;

use crate::incoming::parse_date;

/// The id of the one settings row.
pub(crate) const SETTINGS_ID: &str = "default";

/// `stash_settings` as the planner reads it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Settings {
    pub(crate) enabled: bool,
    pub(crate) service_level: f64,
    pub(crate) review_period_days: i64,
    pub(crate) lookback_days: i64,
    pub(crate) lead_time_days: i64,
    /// Where an order without a pick list counts; `None`: the default
    /// warehouse.
    pub(crate) demand_warehouse_id: Option<String>,
    /// Imported sales history counts only before this day.
    pub(crate) cutover: Option<Date>,
    pub(crate) run_hour_utc: i64,
}

impl Default for Settings {
    /// The column defaults of `stash_settings`.
    fn default() -> Self {
        Self {
            enabled: false,
            service_level: 0.95,
            review_period_days: 7,
            lookback_days: 365,
            lead_time_days: 14,
            demand_warehouse_id: None,
            cutover: None,
            run_hour_utc: 2,
        }
    }
}

/// The row as Drizzle returns it (`default_service_level` as text).
const ROW: &str = "select to_jsonb(t) || jsonb_build_object('default_service_level', \
     t.default_service_level::text) from stash_settings t where t.id = 'default'";

/// `GET /replenishment/settings` without a saved row: the defaults, in the
/// row's shape.
pub(crate) fn defaults_json() -> Value {
    json!({
        "id": SETTINGS_ID,
        "createdAt": null,
        "updatedAt": null,
        "replenishmentEnabled": false,
        "defaultServiceLevel": "0.950",
        "defaultReviewPeriodDays": 7,
        "lookbackDays": 365,
        "defaultLeadTimeDays": 14,
        "demandWarehouseId": null,
        "historyCutoverDate": null,
        "runHourUtc": 2,
    })
}

/// The saved row, or the defaults.
pub(crate) async fn settings_json<'e>(db: impl PgExecutor<'e>) -> Result<Value, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(ROW).fetch_optional(db).await?;
    Ok(row.map_or_else(defaults_json, weldsuite_db::js_row))
}

/// The settings the planner uses.
pub(crate) async fn load_settings<'e>(db: impl PgExecutor<'e>) -> Result<Settings, sqlx::Error> {
    Ok(from_json(&settings_json(db).await?))
}

/// A settings row (or [`defaults_json`]) as [`Settings`].
pub(crate) fn from_json(row: &Value) -> Settings {
    let fallback = Settings::default();
    let int = |key: &str, default: i64| row[key].as_i64().unwrap_or(default);
    Settings {
        enabled: row["replenishmentEnabled"].as_bool().unwrap_or(false),
        service_level: row["defaultServiceLevel"]
            .as_str()
            .and_then(|text| text.parse().ok())
            .unwrap_or(fallback.service_level),
        review_period_days: int("defaultReviewPeriodDays", fallback.review_period_days),
        lookback_days: int("lookbackDays", fallback.lookback_days),
        lead_time_days: int("defaultLeadTimeDays", fallback.lead_time_days),
        demand_warehouse_id: row["demandWarehouseId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        cutover: row["historyCutoverDate"].as_str().and_then(parse_date),
        run_hour_utc: int("runHourUtc", fallback.run_hour_utc),
    }
}

/// The warehouse orders without a pick list count in: the settings'
/// demand warehouse while it is live and active, else the default
/// warehouse, else the first active one. `None` without any warehouse.
pub(crate) async fn demand_warehouse<'e>(
    db: impl PgExecutor<'e>,
    settings: &Settings,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from warehouses where deleted_at is null and coalesce(is_active, true) \
         order by coalesce(id = $1, false) desc, coalesce(is_default, false) desc, created_at, id \
         limit 1",
    )
    .bind(settings.demand_warehouse_id.as_deref())
    .fetch_optional(db)
    .await
}

#[cfg(test)]
mod tests {
    use time::Month;

    use super::*;

    #[test]
    fn the_defaults_read_as_the_column_defaults() {
        assert_eq!(from_json(&defaults_json()), Settings::default());
    }

    #[test]
    fn a_saved_row_reads_its_values() {
        let row = json!({
            "id": "default",
            "replenishmentEnabled": true,
            "defaultServiceLevel": "0.975",
            "defaultReviewPeriodDays": 14,
            "lookbackDays": 180,
            "defaultLeadTimeDays": 21,
            "demandWarehouseId": "wh_1",
            "historyCutoverDate": "2026-03-01",
            "runHourUtc": 5,
        });
        assert_eq!(
            from_json(&row),
            Settings {
                enabled: true,
                service_level: 0.975,
                review_period_days: 14,
                lookback_days: 180,
                lead_time_days: 21,
                demand_warehouse_id: Some("wh_1".to_owned()),
                cutover: Date::from_calendar_date(2026, Month::March, 1).ok(),
                run_hour_utc: 5,
            }
        );
    }
}
