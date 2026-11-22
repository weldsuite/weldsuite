//! `helpdesk_tickets`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_tickets")]
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
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "ticketNumber")]
    pub ticket_number: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "reference")]
    pub reference: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "contactId")]
    pub contact_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "counterpartyId")]
    pub counterparty_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "personId")]
    pub person_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "customerName")]
    pub customer_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "customerEmail")]
    pub customer_email: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "customerPhone")]
    pub customer_phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "customerCompany")]
    pub customer_company: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "subject")]
    pub subject: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "category")]
    pub category: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "subcategory")]
    pub subcategory: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "priority")]
    pub priority: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "severity")]
    pub severity: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "assigneeName")]
    pub assignee_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "departmentId")]
    pub department_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "teamId")]
    pub team_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "channel")]
    pub channel: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sourceEmail")]
    pub source_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "sourceUrl")]
    pub source_url: Option<String>,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(30))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "ticketTypeId")]
    pub ticket_type_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "issueType")]
    pub issue_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "slaId")]
    pub sla_id: Option<String>,
    #[serde(rename = "responseDeadline", with = "crate::js::timestamp::option")]
    pub response_deadline: Option<TimeDateTime>,
    #[serde(rename = "resolutionDeadline", with = "crate::js::timestamp::option")]
    pub resolution_deadline: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "slaStatus")]
    pub sla_status: Option<String>,
    #[serde(rename = "breachedAt", with = "crate::js::timestamp::option")]
    pub breached_at: Option<TimeDateTime>,
    #[serde(rename = "firstResponseAt", with = "crate::js::timestamp::option")]
    pub first_response_at: Option<TimeDateTime>,
    #[serde(rename = "resolvedAt", with = "crate::js::timestamp::option")]
    pub resolved_at: Option<TimeDateTime>,
    #[serde(rename = "closedAt", with = "crate::js::timestamp::option")]
    pub closed_at: Option<TimeDateTime>,
    #[serde(rename = "reopenedAt", with = "crate::js::timestamp::option")]
    pub reopened_at: Option<TimeDateTime>,
    #[serde(rename = "responseTime")]
    pub response_time: Option<i32>,
    #[serde(rename = "resolutionTime")]
    pub resolution_time: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "productId")]
    pub product_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "productName")]
    pub product_name: Option<String>,
    #[serde(rename = "version")]
    pub version: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "environment")]
    pub environment: Option<String>,
    #[serde(rename = "messageCount")]
    pub message_count: Option<i32>,
    #[serde(rename = "lastMessageAt", with = "crate::js::timestamp::option")]
    pub last_message_at: Option<TimeDateTime>,
    #[serde(
        rename = "lastCustomerMessageAt",
        with = "crate::js::timestamp::option"
    )]
    pub last_customer_message_at: Option<TimeDateTime>,
    #[serde(rename = "lastAgentMessageAt", with = "crate::js::timestamp::option")]
    pub last_agent_message_at: Option<TimeDateTime>,
    #[serde(rename = "satisfactionRating")]
    pub satisfaction_rating: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "satisfactionComment")]
    pub satisfaction_comment: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "satisfactionSurveyId")]
    pub satisfaction_survey_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "parentTicketId")]
    pub parent_ticket_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "childTicketIds")]
    pub child_ticket_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "relatedTicketIds")]
    pub related_ticket_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "mergedTicketIds")]
    pub merged_ticket_ids: Option<Json>,
    #[serde(rename = "isEscalated")]
    pub is_escalated: Option<bool>,
    #[serde(rename = "isSpam")]
    pub is_spam: Option<bool>,
    #[serde(rename = "isPublic")]
    pub is_public: Option<bool>,
    #[serde(rename = "requiresApproval")]
    pub requires_approval: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "attachments")]
    pub attachments: Option<Json>,
    #[serde(rename = "attachmentCount")]
    pub attachment_count: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_tickets",
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
            name: "category",
            sql_type: None,
            default: Some(DdlDefault::Sql("'general_inquiry'")),
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
            name: "priority",
            sql_type: None,
            default: Some(DdlDefault::Sql("'medium'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "channel",
            sql_type: None,
            default: Some(DdlDefault::Sql("'web'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'question'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "message_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_escalated",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_spam",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_public",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "requires_approval",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "attachment_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "helpdesk_tickets_contact_id_idx",
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
            name: "helpdesk_tickets_counterparty_idx",
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
            name: "helpdesk_tickets_person_idx",
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
            name: "helpdesk_tickets_customer_email_idx",
            columns: &[IndexColumn {
                expression: "customer_email",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_status_idx",
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
            name: "helpdesk_tickets_priority_idx",
            columns: &[IndexColumn {
                expression: "priority",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_category_idx",
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
            name: "helpdesk_tickets_assignee_idx",
            columns: &[IndexColumn {
                expression: "assignee_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_department_idx",
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
            name: "helpdesk_tickets_channel_idx",
            columns: &[IndexColumn {
                expression: "channel",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_sla_status_idx",
            columns: &[IndexColumn {
                expression: "sla_status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_number_idx",
            columns: &[IndexColumn {
                expression: "ticket_number",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_tickets_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
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
