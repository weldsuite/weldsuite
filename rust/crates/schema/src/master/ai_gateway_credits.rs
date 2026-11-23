//! `ai_gateway_credits`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "ai_gateway_credits")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "gateway")]
    pub gateway: String,
    #[serde(rename = "allowanceNanoUsd")]
    pub allowance_nano_usd: Option<i64>,
    #[serde(rename = "manualAdjustmentNanoUsd")]
    pub manual_adjustment_nano_usd: i64,
    #[serde(rename = "allowanceExpiresAt", with = "crate::js::timestamptz::option")]
    pub allowance_expires_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "resetPolicy")]
    pub reset_policy: String,
    #[serde(rename = "priority")]
    pub priority: i16,
    #[serde(rename = "enabled")]
    pub enabled: bool,
    #[serde(rename = "exhaustionMarginNanoUsd")]
    pub exhaustion_margin_nano_usd: i64,
    #[serde(rename = "spentNanoUsd")]
    pub spent_nano_usd: i64,
    #[serde(rename = "periodStart", with = "crate::js::timestamptz")]
    pub period_start: TimeDateTimeWithTimeZone,
    #[serde(rename = "periodEnd", with = "crate::js::timestamptz")]
    pub period_end: TimeDateTimeWithTimeZone,
    #[serde(rename = "lastRolledUpAt", with = "crate::js::timestamptz::option")]
    pub last_rolled_up_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "ai_gateway_credits",
    columns: &[
        DdlColumn {
            name: "manual_adjustment_nano_usd",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "reset_policy",
            sql_type: None,
            default: Some(DdlDefault::Sql("'monthly'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "priority",
            sql_type: None,
            default: Some(DdlDefault::Number("100")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "exhaustion_margin_nano_usd",
            sql_type: None,
            default: Some(DdlDefault::Number("250000000")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "spent_nano_usd",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "ai_gateway_credits_gateway_idx",
            columns: &[IndexColumn {
                expression: "gateway",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "ai_gateway_credits_enabled_idx",
            columns: &[IndexColumn {
                expression: "enabled",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
