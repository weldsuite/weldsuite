//! `crm_activities`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "crm_activities")]
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
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(30))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "subject")]
    pub subject: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "relatedTo")]
    pub related_to: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "relatedToId")]
    pub related_to_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "relatedToName")]
    pub related_to_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "customerId")]
    pub customer_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "contactId")]
    pub contact_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "counterpartyId")]
    pub counterparty_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "personId")]
    pub person_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "leadId")]
    pub lead_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "opportunityId")]
    pub opportunity_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "assignedToId")]
    pub assigned_to_id: String,
    #[serde(rename = "dueDate", with = "crate::js::timestamp::option")]
    pub due_date: Option<TimeDateTime>,
    #[serde(rename = "startTime", with = "crate::js::timestamp::option")]
    pub start_time: Option<TimeDateTime>,
    #[serde(rename = "endTime", with = "crate::js::timestamp::option")]
    pub end_time: Option<TimeDateTime>,
    #[serde(rename = "duration")]
    pub duration: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "priority")]
    pub priority: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "location")]
    pub location: Option<String>,
    #[serde(rename = "isVirtual")]
    pub is_virtual: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "meetingUrl")]
    pub meeting_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "callDirection")]
    pub call_direction: Option<String>,
    #[serde(rename = "callDuration")]
    pub call_duration: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "callRecordingUrl")]
    pub call_recording_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "emailMessageId")]
    pub email_message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "emailSubject")]
    pub email_subject: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "emailFrom")]
    pub email_from: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "emailTo")]
    pub email_to: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "emailCc")]
    pub email_cc: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "attendees")]
    pub attendees: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "meetingAgenda")]
    pub meeting_agenda: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "meetingNotes")]
    pub meeting_notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "outcome")]
    pub outcome: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "nextAction")]
    pub next_action: Option<String>,
    #[serde(rename = "followUpDate", with = "crate::js::timestamp::option")]
    pub follow_up_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "attachments")]
    pub attachments: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "calendarEventId")]
    pub calendar_event_id: Option<String>,
    #[serde(rename = "isFavorite")]
    pub is_favorite: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "labels")]
    pub labels: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "assigneeIds")]
    pub assignee_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "repeat")]
    pub repeat: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "changeLog")]
    pub change_log: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "crm_activities",
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
            default: Some(DdlDefault::Sql("'planned'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "priority",
            sql_type: None,
            default: Some(DdlDefault::Sql("'medium'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_virtual",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_favorite",
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
            name: "crm_activities_type_idx",
            columns: &[IndexColumn {
                expression: "type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_customer_idx",
            columns: &[IndexColumn {
                expression: "customer_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_contact_idx",
            columns: &[IndexColumn {
                expression: "contact_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_counterparty_idx",
            columns: &[IndexColumn {
                expression: "counterparty_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_person_idx",
            columns: &[IndexColumn {
                expression: "person_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_lead_idx",
            columns: &[IndexColumn {
                expression: "lead_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_opportunity_idx",
            columns: &[IndexColumn {
                expression: "opportunity_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_assigned_to_idx",
            columns: &[IndexColumn {
                expression: "assigned_to_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_due_date_idx",
            columns: &[IndexColumn {
                expression: "due_date",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_activities_calendar_event_idx",
            columns: &[IndexColumn {
                expression: "calendar_event_id",
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
