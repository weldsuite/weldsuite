//! `project_requests`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_requests")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "number")]
    pub number: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "requestedBy")]
    pub requested_by: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "businessCase")]
    pub business_case: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "estimatedCost",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub estimated_cost: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "estimatedValue",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub estimated_value: Option<BigDecimal>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "scores")]
    pub scores: Json,
    #[sea_orm(column_type = "Decimal(Some((8, 2)))")]
    #[serde(
        rename = "score",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub score: Option<BigDecimal>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "neededSkills")]
    pub needed_skills: Json,
    #[serde(rename = "desiredStart", with = "crate::js::date::option")]
    pub desired_start: Option<TimeDate>,
    #[serde(rename = "desiredEnd", with = "crate::js::date::option")]
    pub desired_end: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "submittedAt", with = "crate::js::timestamptz::option")]
    pub submitted_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
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
    name: "project_requests",
    columns: &[
        DdlColumn {
            name: "scores",
            sql_type: None,
            default: Some(DdlDefault::Sql("'{}'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "needed_skills",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'new'")),
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
            name: "project_requests_number_idx",
            columns: &[IndexColumn {
                expression: "number",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_requests_status_score_idx",
            columns: &[
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "score",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "project_requests_project_id_projects_id_fk",
        columns: &["project_id"],
        references: "projects",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[Check {
        name: "project_requests_status_check",
        expression: "\"project_requests\".\"status\" in ('new', 'assessing', 'approved', 'rejected', 'converted')",
    }],
};
