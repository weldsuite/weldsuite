//! `desk_conversations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "desk_conversations")]
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
    #[serde(rename = "conversationNumber")]
    pub conversation_number: i32,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "title")]
    pub title: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "state")]
    pub state: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "channel")]
    pub channel: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "visitorId")]
    pub visitor_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "email")]
    pub email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "contactId")]
    pub contact_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "ticketTypeId")]
    pub ticket_type_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "priority")]
    pub priority: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Json,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "departmentId")]
    pub department_id: Option<String>,
    #[serde(rename = "waitingSince", with = "crate::js::timestamp::option")]
    pub waiting_since: Option<TimeDateTime>,
    #[serde(rename = "lastMessageAt", with = "crate::js::timestamp::option")]
    pub last_message_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(200))")]
    #[serde(rename = "lastMessagePreview")]
    pub last_message_preview: Option<String>,
    #[serde(rename = "rating")]
    pub rating: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "ratingComment")]
    pub rating_comment: Option<String>,
    #[serde(rename = "ratedAt", with = "crate::js::timestamp::option")]
    pub rated_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalId")]
    pub external_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "slaPolicyId")]
    pub sla_policy_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "slaStatus")]
    pub sla_status: Option<String>,
    #[serde(rename = "slaDueAt", with = "crate::js::timestamp::option")]
    pub sla_due_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "slaMetric")]
    pub sla_metric: Option<String>,
    #[serde(rename = "firstResponseAt", with = "crate::js::timestamp::option")]
    pub first_response_at: Option<TimeDateTime>,
    #[serde(rename = "firstResponseSeconds")]
    pub first_response_seconds: Option<i32>,
    #[serde(rename = "resolvedAt", with = "crate::js::timestamp::option")]
    pub resolved_at: Option<TimeDateTime>,
    #[serde(rename = "resolutionSeconds")]
    pub resolution_seconds: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "parentConversationId")]
    pub parent_conversation_id: Option<String>,
    #[serde(rename = "isMajorIncident")]
    pub is_major_incident: bool,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "mergedIntoId")]
    pub merged_into_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "impact")]
    pub impact: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "urgency")]
    pub urgency: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "language")]
    pub language: Option<String>,
    #[serde(rename = "escalationCheckAt", with = "crate::js::timestamp::option")]
    pub escalation_check_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "problemId")]
    pub problem_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "catalogItemId")]
    pub catalog_item_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "approvalStatus")]
    pub approval_status: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "desk_conversations",
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
            name: "state",
            sql_type: None,
            default: Some(DdlDefault::Sql("'open'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "channel",
            sql_type: None,
            default: Some(DdlDefault::Sql("'messenger'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "tags",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_major_incident",
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
            name: "desk_conversations_number_uidx",
            columns: &[IndexColumn {
                expression: "conversation_number",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_external_id_uidx",
            columns: &[IndexColumn {
                expression: "external_id",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: Some("\"desk_conversations\".\"external_id\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_state_waiting_idx",
            columns: &[
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "waiting_since",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_state_last_msg_idx",
            columns: &[
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "last_message_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_assignee_idx",
            columns: &[
                IndexColumn {
                    expression: "assignee_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_visitor_idx",
            columns: &[IndexColumn {
                expression: "visitor_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_channel_idx",
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
            name: "desk_conversations_ticket_type_idx",
            columns: &[
                IndexColumn {
                    expression: "ticket_type_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_priority_idx",
            columns: &[
                IndexColumn {
                    expression: "priority",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_department_idx",
            columns: &[
                IndexColumn {
                    expression: "department_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_tags_gin",
            columns: &[IndexColumn {
                expression: "tags",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "gin",
            filter: None,
        },
        Index {
            name: "desk_conversations_state_sla_due_idx",
            columns: &[
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "sla_due_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_first_response_at_idx",
            columns: &[IndexColumn {
                expression: "first_response_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_resolved_at_idx",
            columns: &[IndexColumn {
                expression: "resolved_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_conversations_parent_idx",
            columns: &[IndexColumn {
                expression: "parent_conversation_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"parent_conversation_id\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_merged_into_idx",
            columns: &[IndexColumn {
                expression: "merged_into_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"merged_into_id\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_escalation_check_idx",
            columns: &[IndexColumn {
                expression: "escalation_check_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"escalation_check_at\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_problem_idx",
            columns: &[IndexColumn {
                expression: "problem_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"problem_id\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_catalog_item_idx",
            columns: &[IndexColumn {
                expression: "catalog_item_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"catalog_item_id\" IS NOT NULL"),
        },
        Index {
            name: "desk_conversations_approval_status_idx",
            columns: &[IndexColumn {
                expression: "approval_status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"desk_conversations\".\"approval_status\" IS NOT NULL"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
