//! `audit_log`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "audit_log")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountingEntityId")]
    pub accounting_entity_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "action")]
    pub action: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "changes")]
    pub changes: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userEmail")]
    pub user_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(45))")]
    #[serde(rename = "ipAddress")]
    pub ip_address: Option<String>,
    #[serde(rename = "timestamp", with = "crate::js::timestamp")]
    pub timestamp: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "audit_log",
    columns: &[DdlColumn {
        name: "timestamp",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_audit_log_accounting_entity_idx",
            columns: &[IndexColumn {
                expression: "accounting_entity_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_audit_log_entity_idx",
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
            name: "acct_audit_log_user_idx",
            columns: &[IndexColumn {
                expression: "user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_audit_log_timestamp_idx",
            columns: &[IndexColumn {
                expression: "timestamp",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_audit_log_action_idx",
            columns: &[IndexColumn {
                expression: "action",
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
