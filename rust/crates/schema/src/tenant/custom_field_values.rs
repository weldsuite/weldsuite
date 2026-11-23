//! `custom_field_values`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "custom_field_values")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "fieldId")]
    pub field_id: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "valueText")]
    pub value_text: Option<String>,
    #[serde(rename = "valueNumber")]
    pub value_number: Option<f64>,
    #[serde(rename = "valueDate", with = "crate::js::timestamp::option")]
    pub value_date: Option<TimeDateTime>,
    #[serde(rename = "valueBool")]
    pub value_bool: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "valueJson")]
    pub value_json: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "valueRef")]
    pub value_ref: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "custom_field_values",
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "cfv_entity_field_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "entity_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_entity_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "entity_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_field_text_idx",
            columns: &[
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "value_text",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_field_number_idx",
            columns: &[
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "value_number",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_field_date_idx",
            columns: &[
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "value_date",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_field_bool_idx",
            columns: &[
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "value_bool",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cfv_field_ref_idx",
            columns: &[
                IndexColumn {
                    expression: "field_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "value_ref",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
