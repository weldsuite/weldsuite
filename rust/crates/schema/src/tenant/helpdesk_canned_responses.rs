//! `helpdesk_canned_responses`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_canned_responses")]
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
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "subject")]
    pub subject: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "content")]
    pub content: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "category")]
    pub category: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "scope")]
    pub scope: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "teamId")]
    pub team_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "departmentId")]
    pub department_id: Option<String>,
    #[serde(rename = "usageCount")]
    pub usage_count: Option<i32>,
    #[serde(rename = "lastUsedAt", with = "crate::js::timestamp::option")]
    pub last_used_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "shortcut")]
    pub shortcut: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "keywords")]
    pub keywords: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "actions")]
    pub actions: Option<Json>,
    #[serde(rename = "isActive")]
    pub is_active: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_canned_responses",
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
            name: "scope",
            sql_type: None,
            default: Some(DdlDefault::Sql("'personal'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "usage_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "helpdesk_canned_responses_scope_idx",
            columns: &[IndexColumn {
                expression: "scope",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_canned_responses_agent_idx",
            columns: &[IndexColumn {
                expression: "agent_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_canned_responses_department_idx",
            columns: &[IndexColumn {
                expression: "department_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_canned_responses_category_idx",
            columns: &[IndexColumn {
                expression: "category",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_canned_responses_is_active_idx",
            columns: &[IndexColumn {
                expression: "is_active",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_canned_responses_shortcut_idx",
            columns: &[IndexColumn {
                expression: "shortcut",
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
