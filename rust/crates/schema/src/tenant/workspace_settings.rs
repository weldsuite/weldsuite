//! `workspace_settings`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workspace_settings")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(255))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "theme")]
    pub theme: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "timezone")]
    pub timezone: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "language")]
    pub language: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "dateFormat")]
    pub date_format: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "timeFormat")]
    pub time_format: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "legalName")]
    pub legal_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "tradingName")]
    pub trading_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contactFirstName")]
    pub contact_first_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contactLastName")]
    pub contact_last_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "email")]
    pub email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "phone")]
    pub phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "addressLine1")]
    pub address_line_1: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "addressLine2")]
    pub address_line_2: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "city")]
    pub city: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "state")]
    pub state: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "postalCode")]
    pub postal_code: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "country")]
    pub country: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "vatNumber")]
    pub vat_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "registrationNumber")]
    pub registration_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "logoUrl")]
    pub logo_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "websiteUrl")]
    pub website_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "primaryColor")]
    pub primary_color: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "accentColor")]
    pub accent_color: Option<String>,
    #[serde(rename = "emailNotificationsEnabled")]
    pub email_notifications_enabled: bool,
    #[serde(rename = "pushNotificationsEnabled")]
    pub push_notifications_enabled: bool,
    /// Feature switches. `outsideEu` holds the services outside the EU the
    /// workspace switched on (ADR OPS-026), by service id: `{ enabled,
    /// enabledBy, enabledAt, acknowledgedAt, via: admin|staff|move, reason,
    /// disabledBy, disabledAt }`. Written only by `crates/outside-eu`; no
    /// entry, or `enabled: false`, is off.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "features")]
    pub features: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeCustomerId")]
    pub stripe_customer_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeSubscriptionId")]
    pub stripe_subscription_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customSettings")]
    pub custom_settings: Option<Json>,
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
    name: "workspace_settings",
    columns: &[
        DdlColumn {
            name: "email_notifications_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "push_notifications_enabled",
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
    indexes: &[],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
