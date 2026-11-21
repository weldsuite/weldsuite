//! `workspace_credits`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workspace_credits")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "currentBalance")]
    pub current_balance: i32,
    #[serde(rename = "planCredits")]
    pub plan_credits: i32,
    #[serde(rename = "subscribedCredits")]
    pub subscribed_credits: i32,
    #[serde(rename = "monthlyAllocation")]
    pub monthly_allocation: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeCreditsItemId")]
    pub stripe_credits_item_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeCreditsPriceId")]
    pub stripe_credits_price_id: Option<String>,
    #[serde(rename = "rolledOverCredits")]
    pub rolled_over_credits: i32,
    #[serde(rename = "rolloverCap")]
    pub rollover_cap: Option<i32>,
    #[serde(rename = "periodStart", with = "crate::js::timestamptz")]
    pub period_start: TimeDateTimeWithTimeZone,
    #[serde(rename = "periodEnd", with = "crate::js::timestamptz")]
    pub period_end: TimeDateTimeWithTimeZone,
    #[serde(rename = "lastResetAt", with = "crate::js::timestamptz::option")]
    pub last_reset_at: Option<TimeDateTimeWithTimeZone>,
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
    name: "workspace_credits",
    columns: &[
        DdlColumn {
            name: "current_balance",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "plan_credits",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "subscribed_credits",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "monthly_allocation",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "rolled_over_credits",
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
            name: "workspace_credits_workspace_id_idx",
            columns: &[IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workspace_credits_period_end_idx",
            columns: &[IndexColumn {
                expression: "period_end",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "workspace_credits_workspace_id_workspaces_id_fk",
        columns: &["workspace_id"],
        references: "workspaces",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
