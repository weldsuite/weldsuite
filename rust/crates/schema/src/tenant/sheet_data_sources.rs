//! `sheet_data_sources`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sheet_data_sources")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(255))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sheetId")]
    pub sheet_id: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "objectType")]
    pub object_type: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "definition")]
    pub definition: Json,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "refresh")]
    pub refresh: String,
    #[serde(rename = "lastRefreshedAt", with = "crate::js::timestamp::option")]
    pub last_refreshed_at: Option<TimeDateTime>,
    #[serde(rename = "nextRefreshAt", with = "crate::js::timestamp::option")]
    pub next_refresh_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "rowCount")]
    pub row_count: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdById")]
    pub created_by_id: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "sheet_data_sources",
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
            name: "refresh",
            sql_type: None,
            default: Some(DdlDefault::Sql("'manual'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "row_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "sheet_data_sources_sheet_idx",
        columns: &[IndexColumn {
            expression: "sheet_id",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[ForeignKey {
        name: "sheet_data_sources_sheet_id_sheets_id_fk",
        columns: &["sheet_id"],
        references: "sheets",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
