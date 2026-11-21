//! `user_apps`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "user_apps")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "code")]
    pub code: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "icon")]
    pub icon: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "category")]
    pub category: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerWorkspaceId")]
    pub owner_workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "publisherType")]
    pub publisher_type: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "visibility")]
    pub visibility: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "reviewStatus")]
    pub review_status: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "reviewNotes")]
    pub review_notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reviewedBy")]
    pub reviewed_by: Option<String>,
    #[serde(rename = "reviewedAt", with = "crate::js::timestamptz::option")]
    pub reviewed_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "currentVersionId")]
    pub current_version_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "manifest")]
    pub manifest: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "requestedScopes")]
    pub requested_scopes: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "pricingType")]
    pub pricing_type: String,
    #[sea_orm(column_type = "Decimal(Some((10, 2)))")]
    #[serde(
        rename = "priceMonthly",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub price_monthly: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[serde(rename = "platformFeePercent")]
    pub platform_fee_percent: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeProductId")]
    pub stripe_product_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripePriceId")]
    pub stripe_price_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "websiteUrl")]
    pub website_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "privacyUrl")]
    pub privacy_url: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "screenshots")]
    pub screenshots: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "webhookUrl")]
    pub webhook_url: Option<String>,
    #[serde(rename = "installCount")]
    pub install_count: i32,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "user_apps",
    columns: &[
        DdlColumn {
            name: "icon",
            sql_type: None,
            default: Some(DdlDefault::Sql("'Puzzle'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "category",
            sql_type: None,
            default: Some(DdlDefault::Sql("'Productivity'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "publisher_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'community'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "visibility",
            sql_type: None,
            default: Some(DdlDefault::Sql("'private'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "review_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "requested_scopes",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "pricing_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'free'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "currency",
            sql_type: None,
            default: Some(DdlDefault::Sql("'EUR'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "platform_fee_percent",
            sql_type: None,
            default: Some(DdlDefault::Number("15")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "screenshots",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "install_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
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
            name: "user_apps_owner_workspace_id_idx",
            columns: &[IndexColumn {
                expression: "owner_workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "user_apps_visibility_idx",
            columns: &[IndexColumn {
                expression: "visibility",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "user_apps_review_status_idx",
            columns: &[IndexColumn {
                expression: "review_status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "user_apps_code_unique",
        columns: &["code"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
