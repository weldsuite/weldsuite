//! `sign_fields`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sign_fields")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "documentId")]
    pub document_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "recipientId")]
    pub recipient_id: String,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(20))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "page")]
    pub page: i32,
    #[serde(rename = "x", with = "crate::js::real")]
    pub x: f32,
    #[serde(rename = "y", with = "crate::js::real")]
    pub y: f32,
    #[serde(rename = "width", with = "crate::js::real")]
    pub width: f32,
    #[serde(rename = "height", with = "crate::js::real")]
    pub height: f32,
    #[serde(rename = "required")]
    pub required: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "label")]
    pub label: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "value")]
    pub value: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "signatureKey")]
    pub signature_key: Option<String>,
    #[serde(rename = "filledAt", with = "crate::js::timestamptz::option")]
    pub filled_at: Option<TimeDateTimeWithTimeZone>,
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
    name: "sign_fields",
    columns: &[
        DdlColumn {
            name: "required",
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
            name: "sign_fields_envelope_idx",
            columns: &[IndexColumn {
                expression: "envelope_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sign_fields_recipient_idx",
            columns: &[IndexColumn {
                expression: "recipient_id",
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
