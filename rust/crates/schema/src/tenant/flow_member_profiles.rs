//! `flow_member_profiles`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "flow_member_profiles")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[sea_orm(column_type = "Decimal(Some((5, 2)))")]
    #[serde(
        rename = "weeklyHours",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub weekly_hours: BigDecimal,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "skills")]
    pub skills: Json,
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
    name: "flow_member_profiles",
    columns: &[
        DdlColumn {
            name: "weekly_hours",
            sql_type: None,
            default: Some(DdlDefault::Sql("'40'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "skills",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
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
    indexes: &[Index {
        name: "flow_member_profiles_member_idx",
        columns: &[IndexColumn {
            expression: "member_id",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[Check {
        name: "flow_member_profiles_hours_check",
        expression: "\"flow_member_profiles\".\"weekly_hours\" between 0 and 168",
    }],
};
