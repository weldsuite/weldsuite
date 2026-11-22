//! `annual_reports`: an entity's jaarrekening for one financial year, as
//! filed with the KvK (the publicatiestukken of a micro or small company).

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "annual_reports")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    /// The calendar year the financial year ends in.
    #[serde(rename = "fiscalYear")]
    pub fiscal_year: i32,
    #[serde(rename = "periodStart", with = "crate::js::timestamp")]
    pub period_start: TimeDateTime,
    #[serde(rename = "periodEnd", with = "crate::js::timestamp")]
    pub period_end: TimeDateTime,
    /// `micro` or `small` (art. 2:395a and 2:396 BW).
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "sizeClass")]
    pub size_class: String,
    /// `draft`, `submitted`, `accepted`, `rejected` or `filed`.
    #[sea_orm(column_type = "String(StringLen::N(15))")]
    #[serde(rename = "status")]
    pub status: String,
    /// The balance sheet (this year and the year before), from the ledger
    /// and then as the user corrected it.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "figures")]
    pub figures: Option<Json>,
    /// The notes the publication carries (average number of employees, …).
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "disclosures")]
    pub disclosures: Option<Json>,
    /// Whether the general meeting adopted (vastgesteld) the accounts.
    #[serde(rename = "adopted")]
    pub adopted: bool,
    #[serde(rename = "adoptionDate", with = "crate::js::timestamp::option")]
    pub adoption_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "xmlContent")]
    pub xml_content: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "filingReference")]
    pub filing_reference: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "digipoortResponse")]
    pub digipoort_response: Option<Json>,
    #[serde(rename = "filedAt", with = "crate::js::timestamp::option")]
    pub filed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "filedBy")]
    pub filed_by: Option<String>,
    #[serde(rename = "acceptedAt", with = "crate::js::timestamp::option")]
    pub accepted_at: Option<TimeDateTime>,
    #[serde(rename = "rejectedAt", with = "crate::js::timestamp::option")]
    pub rejected_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "rejectionReason")]
    pub rejection_reason: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "annual_reports",
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
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "adopted",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "annual_reports_entity_year_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "fiscal_year",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "annual_reports_status_idx",
            columns: &[IndexColumn {
                expression: "status",
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
