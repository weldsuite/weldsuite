//! `panel_dashboard_tiles`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "panel_dashboard_tiles")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "dashboardId")]
    pub dashboard_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reportId")]
    pub report_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "text")]
    pub text: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "layout")]
    pub layout: Json,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "panel_dashboard_tiles",
    columns: &[
        DdlColumn {
            name: "kind",
            sql_type: None,
            default: Some(DdlDefault::Sql("'report'")),
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
        name: "panel_dashboard_tiles_dashboard_idx",
        columns: &[IndexColumn {
            expression: "dashboard_id",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
