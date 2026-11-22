//! `reach_enrollments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "reach_enrollments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "campaignId")]
    pub campaign_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "prospectId")]
    pub prospect_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "mailboxId")]
    pub mailbox_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "currentStep")]
    pub current_step: i32,
    #[serde(rename = "nextSendAt", with = "crate::js::timestamptz::option")]
    pub next_send_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "claimedAt", with = "crate::js::timestamptz::option")]
    pub claimed_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "lastMessageId")]
    pub last_message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "threadRootMessageId")]
    pub thread_root_message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "stoppedReason")]
    pub stopped_reason: Option<String>,
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
    name: "reach_enrollments",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'queued'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "current_step",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "reach_enrollments_campaign_prospect_idx",
            columns: &[
                IndexColumn {
                    expression: "campaign_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "prospect_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_enrollments_due_idx",
            columns: &[
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "next_send_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_enrollments_prospect_idx",
            columns: &[IndexColumn {
                expression: "prospect_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_enrollments_mailbox_idx",
            columns: &[IndexColumn {
                expression: "mailbox_id",
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
