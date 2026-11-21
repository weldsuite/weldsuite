//! `form_invitations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "form_invitations")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "formId")]
    pub form_id: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "email")]
    pub email: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "personId")]
    pub person_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "locale")]
    pub locale: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "subject")]
    pub subject: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "message")]
    pub message: Option<String>,
    #[serde(rename = "reminderAfterDays")]
    pub reminder_after_days: Option<i32>,
    #[serde(rename = "reminderEveryDays")]
    pub reminder_every_days: Option<i32>,
    #[serde(rename = "reminderMaxCount")]
    pub reminder_max_count: i32,
    #[serde(rename = "remindersSent")]
    pub reminders_sent: i32,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "responseId")]
    pub response_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "invitedByUserId")]
    pub invited_by_user_id: String,
    #[serde(rename = "sentAt", with = "crate::js::timestamptz::option")]
    pub sent_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "openedAt", with = "crate::js::timestamptz::option")]
    pub opened_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "startedAt", with = "crate::js::timestamptz::option")]
    pub started_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "completedAt", with = "crate::js::timestamptz::option")]
    pub completed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "lastRemindedAt", with = "crate::js::timestamptz::option")]
    pub last_reminded_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "nextReminderAt", with = "crate::js::timestamptz::option")]
    pub next_reminder_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "revokedAt", with = "crate::js::timestamptz::option")]
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
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
    name: "form_invitations",
    columns: &[
        DdlColumn {
            name: "locale",
            sql_type: None,
            default: Some(DdlDefault::Sql("'en'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'sent'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "reminder_max_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "reminders_sent",
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
            name: "form_invitations_form_status_idx",
            columns: &[
                IndexColumn {
                    expression: "form_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "form_invitations_email_idx",
            columns: &[
                IndexColumn {
                    expression: "form_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "email",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "form_invitations_next_reminder_idx",
            columns: &[IndexColumn {
                expression: "next_reminder_at",
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
