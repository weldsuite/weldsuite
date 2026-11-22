//! `stash_settings`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "stash_settings")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "replenishmentEnabled")]
    pub replenishment_enabled: bool,
    #[sea_orm(column_type = "Decimal(Some((4, 3)))")]
    #[serde(
        rename = "defaultServiceLevel",
        serialize_with = "crate::js::Numeric::<3>::serialize"
    )]
    pub default_service_level: BigDecimal,
    #[serde(rename = "defaultReviewPeriodDays")]
    pub default_review_period_days: i32,
    #[serde(rename = "lookbackDays")]
    pub lookback_days: i32,
    #[serde(rename = "defaultLeadTimeDays")]
    pub default_lead_time_days: i32,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "demandWarehouseId")]
    pub demand_warehouse_id: Option<String>,
    #[serde(rename = "historyCutoverDate", with = "crate::js::date::option")]
    pub history_cutover_date: Option<TimeDate>,
    #[serde(rename = "runHourUtc")]
    pub run_hour_utc: i16,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "stash_settings",
    columns: &[
        DdlColumn {
            name: "created_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "updated_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "replenishment_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "default_service_level",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0.950'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "default_review_period_days",
            sql_type: None,
            default: Some(DdlDefault::Number("7")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "lookback_days",
            sql_type: None,
            default: Some(DdlDefault::Number("365")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "default_lead_time_days",
            sql_type: None,
            default: Some(DdlDefault::Number("14")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "run_hour_utc",
            sql_type: None,
            default: Some(DdlDefault::Number("2")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
