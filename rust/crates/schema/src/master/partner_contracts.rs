//! `partner_contracts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "partner_contracts")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "partnerId")]
    pub partner_id: String,
    #[serde(rename = "effectiveFrom", with = "crate::js::timestamptz")]
    pub effective_from: TimeDateTimeWithTimeZone,
    #[serde(rename = "effectiveTo", with = "crate::js::timestamptz::option")]
    pub effective_to: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[serde(rename = "revenueShareBps")]
    pub revenue_share_bps: i32,
    #[sea_orm(column_type = "Decimal(Some((12, 2)))")]
    #[serde(
        rename = "baseMinimum",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub base_minimum: BigDecimal,
    #[serde(rename = "includedSeats")]
    pub included_seats: i32,
    #[sea_orm(column_type = "Decimal(Some((12, 2)))")]
    #[serde(
        rename = "seatFloorPrice",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub seat_floor_price: BigDecimal,
    #[serde(rename = "includedCredits")]
    pub included_credits: i32,
    #[sea_orm(column_type = "Decimal(Some((12, 6)))")]
    #[serde(
        rename = "creditFloorPrice",
        serialize_with = "crate::js::Numeric::<6>::serialize"
    )]
    pub credit_floor_price: BigDecimal,
    #[sea_orm(column_type = "Decimal(Some((12, 6)))")]
    #[serde(
        rename = "extraCreditPrice",
        serialize_with = "crate::js::Numeric::<6>::serialize"
    )]
    pub extra_credit_price: BigDecimal,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "allowedFeaturePlanIds")]
    pub allowed_feature_plan_ids: Json,
    #[serde(rename = "paymentTermsDays")]
    pub payment_terms_days: i32,
    #[serde(rename = "pastDueAfterDays")]
    pub past_due_after_days: i32,
    #[serde(rename = "readOnlyAfterDays")]
    pub read_only_after_days: i32,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "partner_contracts",
    columns: &[
        DdlColumn {
            name: "currency",
            sql_type: None,
            default: Some(DdlDefault::Sql("'USD'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "revenue_share_bps",
            sql_type: None,
            default: Some(DdlDefault::Number("7500")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "base_minimum",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "included_seats",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "seat_floor_price",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "included_credits",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "credit_floor_price",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "extra_credit_price",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "allowed_feature_plan_ids",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "payment_terms_days",
            sql_type: None,
            default: Some(DdlDefault::Number("30")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "past_due_after_days",
            sql_type: None,
            default: Some(DdlDefault::Number("14")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "read_only_after_days",
            sql_type: None,
            default: Some(DdlDefault::Number("30")),
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
    ],
    primary_key: None,
    indexes: &[Index {
        name: "partner_contracts_partner_idx",
        columns: &[
            IndexColumn {
                expression: "partner_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "effective_from",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[ForeignKey {
        name: "partner_contracts_partner_id_partners_id_fk",
        columns: &["partner_id"],
        references: "partners",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
