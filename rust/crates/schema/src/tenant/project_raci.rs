//! `project_raci`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_raci")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "subjectType")]
    pub subject_type: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "subjectId")]
    pub subject_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "stakeholderId")]
    pub stakeholder_id: String,
    #[sea_orm(column_type = "String(StringLen::N(1))")]
    #[serde(rename = "letter")]
    pub letter: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
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
    name: "project_raci",
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
            name: "project_raci_project_subject_idx",
            columns: &[
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "subject_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "subject_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_raci_stakeholder_idx",
            columns: &[IndexColumn {
                expression: "stakeholder_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_raci_cell_idx",
            columns: &[
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "subject_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"subject_id\", '')",
                    is_expression: true,
                    asc: true,
                },
                IndexColumn {
                    expression: "stakeholder_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "letter",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_raci_one_accountable_idx",
            columns: &[
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "subject_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"subject_id\", '')",
                    is_expression: true,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("\"project_raci\".\"letter\" = 'A'"),
        },
    ],
    foreign_keys: &[
        ForeignKey {
            name: "project_raci_project_id_projects_id_fk",
            columns: &["project_id"],
            references: "projects",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
        ForeignKey {
            name: "project_raci_stakeholder_id_project_stakeholders_id_fk",
            columns: &["stakeholder_id"],
            references: "project_stakeholders",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[
        Check {
            name: "project_raci_subject_type_check",
            expression: "\"project_raci\".\"subject_type\" in ('deliverable', 'change_requests', 'go_live')",
        },
        Check {
            name: "project_raci_letter_check",
            expression: "\"project_raci\".\"letter\" in ('R', 'A', 'C', 'I')",
        },
        Check {
            name: "project_raci_subject_check",
            expression: "(\"project_raci\".\"subject_type\" = 'deliverable') = (\"project_raci\".\"subject_id\" is not null)",
        },
    ],
};
