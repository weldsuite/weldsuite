//! `flow_approval_delegations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "flow_approval_delegations")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "delegateId")]
    pub delegate_id: String,
    #[serde(rename = "startsAt", with = "crate::js::timestamptz")]
    pub starts_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "endsAt", with = "crate::js::timestamptz")]
    pub ends_at: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
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
    name: "flow_approval_delegations",
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
            name: "flow_approval_delegations_member_idx",
            columns: &[
                IndexColumn {
                    expression: "member_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "starts_at",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "ends_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "flow_approval_delegations_delegate_idx",
            columns: &[
                IndexColumn {
                    expression: "delegate_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "starts_at",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "ends_at",
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
    checks: &[
        Check {
            name: "flow_approval_delegations_period_check",
            expression: "\"flow_approval_delegations\".\"ends_at\" > \"flow_approval_delegations\".\"starts_at\"",
        },
        Check {
            name: "flow_approval_delegations_self_check",
            expression: "\"flow_approval_delegations\".\"member_id\" <> \"flow_approval_delegations\".\"delegate_id\"",
        },
    ],
};
