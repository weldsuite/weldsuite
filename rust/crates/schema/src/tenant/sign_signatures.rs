//! `sign_signatures`: every cryptographic signature, seal and document
//! timestamp in a WeldSign request's PDF (plan weldsign-eidas). Who held the
//! certificate and who issued it, never identity documents or keys.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sign_signatures")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    /// The signer; unset for the seal and document timestamps.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "recipientId")]
    pub recipient_id: Option<String>,
    /// `signature`, `seal` or `document_timestamp`.
    #[sea_orm(column_type = "String(StringLen::N(24))")]
    #[serde(rename = "kind")]
    pub kind: String,
    /// `aes`, `qes` or `seal`.
    #[sea_orm(column_type = "String(StringLen::N(8))")]
    #[serde(rename = "level")]
    pub level: Option<String>,
    /// Which file: `final` or `evidence`.
    #[sea_orm(column_type = "String(StringLen::N(16))")]
    #[serde(rename = "document")]
    pub document: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "provider")]
    pub provider: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "certificateSubject")]
    pub certificate_subject: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "certificateIssuer")]
    pub certificate_issuer: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(128))")]
    #[serde(rename = "certificateSerial")]
    pub certificate_serial: Option<String>,
    #[serde(
        rename = "certificateNotAfter",
        with = "crate::js::timestamptz::option"
    )]
    pub certificate_not_after: Option<TimeDateTimeWithTimeZone>,
    /// A qualified certificate with its key in a QSCD.
    #[serde(rename = "qualified")]
    pub qualified: bool,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "identityMethod")]
    pub identity_method: Option<String>,
    #[serde(rename = "signedAt", with = "crate::js::timestamptz::option")]
    pub signed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "timestampAt", with = "crate::js::timestamptz::option")]
    pub timestamp_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "sign_signatures",
    columns: &[
        DdlColumn {
            name: "qualified",
            sql_type: None,
            default: Some(DdlDefault::Sql("false")),
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
    ],
    primary_key: None,
    indexes: &[Index {
        name: "sign_signatures_envelope_idx",
        columns: &[
            IndexColumn {
                expression: "envelope_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
