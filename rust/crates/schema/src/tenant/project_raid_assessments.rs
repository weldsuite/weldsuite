//! `project_raid_assessments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_raid_assessments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "itemId")]
    pub item_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "probability")]
    pub probability: i16,
    #[serde(rename = "impact")]
    pub impact: i16,
    #[serde(rename = "score")]
    pub score: Option<i32>,
    #[serde(rename = "residualProbability")]
    pub residual_probability: Option<i16>,
    #[serde(rename = "residualImpact")]
    pub residual_impact: Option<i16>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "note")]
    pub note: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "assessedBy")]
    pub assessed_by: String,
    #[serde(rename = "assessedAt", with = "crate::js::timestamptz")]
    pub assessed_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "project_raid_assessments",
    columns: &[
        DdlColumn {
            name: "score",
            sql_type: None,
            default: None,
            generated: Some("probability * impact"),
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "assessed_at",
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
            name: "project_raid_assessments_item_idx",
            columns: &[
                IndexColumn {
                    expression: "item_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "assessed_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_raid_assessments_project_idx",
            columns: &[IndexColumn {
                expression: "project_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[
        ForeignKey {
            name: "project_raid_assessments_item_id_project_raid_items_id_fk",
            columns: &["item_id"],
            references: "project_raid_items",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
        ForeignKey {
            name: "project_raid_assessments_project_id_projects_id_fk",
            columns: &["project_id"],
            references: "projects",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[Check {
        name: "project_raid_assessments_scale_check",
        expression: "\"project_raid_assessments\".\"probability\" between 1 and 5 and \"project_raid_assessments\".\"impact\" between 1 and 5\n        and (\"project_raid_assessments\".\"residual_probability\" is null or \"project_raid_assessments\".\"residual_probability\" between 1 and 5)\n        and (\"project_raid_assessments\".\"residual_impact\" is null or \"project_raid_assessments\".\"residual_impact\" between 1 and 5)",
    }],
};
