//! `order_approvals`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "order_approvals")]
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
    #[serde(rename = "orderId")]
    pub order_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reason")]
    pub reason: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "requestedByPersonId")]
    pub requested_by_person_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "approverPersonId")]
    pub approver_person_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "decision")]
    pub decision: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "comment")]
    pub comment: Option<String>,
    #[serde(rename = "decidedAt", with = "crate::js::timestamp::option")]
    pub decided_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "order_approvals",
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
            name: "reason",
            sql_type: None,
            default: Some(DdlDefault::Sql("'buyer_limit'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "decision",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "order_approvals_order_idx",
            columns: &[IndexColumn {
                expression: "order_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "order_approvals_approver_idx",
            columns: &[IndexColumn {
                expression: "approver_person_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "order_approvals_decision_idx",
            columns: &[IndexColumn {
                expression: "decision",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "order_approvals_order_pending_uidx",
            columns: &[IndexColumn {
                expression: "order_id",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: Some("\"order_approvals\".\"decision\" = 'pending'"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
