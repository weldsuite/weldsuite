//! `workspace_sso`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workspace_sso")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "clerkOrgId")]
    pub clerk_org_id: String,
    #[sea_orm(column_type = "String(StringLen::N(253))")]
    #[serde(rename = "domain")]
    pub domain: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "domainVerificationToken")]
    pub domain_verification_token: Option<String>,
    #[serde(rename = "domainVerifiedAt", with = "crate::js::timestamptz::option")]
    pub domain_verified_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "clerkConnectionId")]
    pub clerk_connection_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "provider")]
    pub provider: Option<String>,
    #[serde(rename = "enabled")]
    pub enabled: bool,
    #[serde(rename = "clerkActive")]
    pub clerk_active: bool,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "acsUrl")]
    pub acs_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "spEntityId")]
    pub sp_entity_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "spMetadataUrl")]
    pub sp_metadata_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "connectionUpdatedBy")]
    pub connection_updated_by: Option<String>,
    #[serde(
        rename = "connectionUpdatedAt",
        with = "crate::js::timestamptz::option"
    )]
    pub connection_updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "priceOverrideCents")]
    pub price_override_cents: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "priceOverrideCurrency")]
    pub price_override_currency: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "priceOverrideSetBy")]
    pub price_override_set_by: Option<String>,
    #[serde(rename = "priceOverrideSetAt", with = "crate::js::timestamptz::option")]
    pub price_override_set_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "priceOverrideReason")]
    pub price_override_reason: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeSubscriptionId")]
    pub stripe_subscription_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "subscriptionStatus")]
    pub subscription_status: String,
    #[serde(
        rename = "subscriptionStatusAt",
        with = "crate::js::timestamptz::option"
    )]
    pub subscription_status_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(
        rename = "subscriptionCurrentPeriodEnd",
        with = "crate::js::timestamptz::option"
    )]
    pub subscription_current_period_end: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "subscriptionCancelAtPeriodEnd")]
    pub subscription_cancel_at_period_end: bool,
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
    name: "workspace_sso",
    columns: &[
        DdlColumn {
            name: "enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "clerk_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "subscription_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'none'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "subscription_cancel_at_period_end",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "workspace_sso_workspace_idx",
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
            name: "workspace_sso_verified_domain_idx",
            columns: &[IndexColumn {
                expression: "domain",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: Some("\"workspace_sso\".\"domain_verified_at\" is not null"),
        },
        Index {
            name: "workspace_sso_clerk_org_idx",
            columns: &[IndexColumn {
                expression: "clerk_org_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workspace_sso_subscription_idx",
            columns: &[IndexColumn {
                expression: "stripe_subscription_id",
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
