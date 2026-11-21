//! `domain_transfers`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "domain_transfers")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "domainId")]
    pub domain_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domainName")]
    pub domain_name: String,
    #[sea_orm(column_name = "type")]
    #[serde(rename = "type")]
    pub type_: super::enums::HostDomainTransferType,
    #[serde(rename = "status")]
    pub status: super::enums::HostDomainTransferStatus,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authCode")]
    pub auth_code: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fromRegistrar")]
    pub from_registrar: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "toRegistrar")]
    pub to_registrar: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalTransferId")]
    pub external_transfer_id: Option<String>,
    #[serde(rename = "requestedAt", with = "crate::js::timestamp")]
    pub requested_at: TimeDateTime,
    #[serde(rename = "approvedAt", with = "crate::js::timestamp::option")]
    pub approved_at: Option<TimeDateTime>,
    #[serde(rename = "rejectedAt", with = "crate::js::timestamp::option")]
    pub rejected_at: Option<TimeDateTime>,
    #[serde(rename = "cancelledAt", with = "crate::js::timestamp::option")]
    pub cancelled_at: Option<TimeDateTime>,
    #[serde(rename = "completedAt", with = "crate::js::timestamp::option")]
    pub completed_at: Option<TimeDateTime>,
    #[serde(rename = "expiresAt", with = "crate::js::timestamp::option")]
    pub expires_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "rejectionReason")]
    pub rejection_reason: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "cancellationReason")]
    pub cancellation_reason: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "failureReason")]
    pub failure_reason: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "notificationsSent")]
    pub notifications_sent: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "registrarResponse")]
    pub registrar_response: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "domain_transfers",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "requested_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
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
            name: "domain_transfers_domain_id_idx",
            columns: &[IndexColumn {
                expression: "domain_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "domain_transfers_domain_name_idx",
            columns: &[IndexColumn {
                expression: "domain_name",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "domain_transfers_status_idx",
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
            name: "domain_transfers_type_idx",
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
            name: "domain_transfers_external_transfer_id_idx",
            columns: &[IndexColumn {
                expression: "external_transfer_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "domain_transfers_domain_id_domains_id_fk",
        columns: &["domain_id"],
        references: "domains",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
