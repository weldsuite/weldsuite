//! `user_preferences`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "user_preferences")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "theme")]
    pub theme: String,
    #[serde(rename = "fontSize")]
    pub font_size: i32,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "language")]
    pub language: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "dateFormat")]
    pub date_format: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "timeFormat")]
    pub time_format: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "timezone")]
    pub timezone: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "notifications")]
    pub notifications: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "workingHours")]
    pub working_hours: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "uiPreferences")]
    pub ui_preferences: Option<Json>,
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
    name: "user_preferences",
    columns: &[
        DdlColumn {
            name: "theme",
            sql_type: None,
            default: Some(DdlDefault::Sql("'system'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "font_size",
            sql_type: None,
            default: Some(DdlDefault::Number("16")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "language",
            sql_type: None,
            default: Some(DdlDefault::Sql("'en'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "date_format",
            sql_type: None,
            default: Some(DdlDefault::Sql("'MM/DD/YYYY'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "time_format",
            sql_type: None,
            default: Some(DdlDefault::Sql("'12h'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "timezone",
            sql_type: None,
            default: Some(DdlDefault::Sql("'UTC'")),
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
