//! `workflow_templates`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workflow_templates")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "shortDescription")]
    pub short_description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "category")]
    pub category: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "triggers")]
    pub triggers: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "steps")]
    pub steps: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "settings")]
    pub settings: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "configurationSchema")]
    pub configuration_schema: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "difficulty")]
    pub difficulty: Option<String>,
    #[serde(rename = "estimatedSetupTime")]
    pub estimated_setup_time: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "thumbnail")]
    pub thumbnail: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "color")]
    pub color: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorId")]
    pub author_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorName")]
    pub author_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "authorAvatar")]
    pub author_avatar: Option<String>,
    #[serde(rename = "isOfficial")]
    pub is_official: bool,
    #[serde(rename = "isPublic")]
    pub is_public: bool,
    #[serde(rename = "isVerified")]
    pub is_verified: bool,
    #[serde(rename = "publishedAt", with = "crate::js::timestamp::option")]
    pub published_at: Option<TimeDateTime>,
    #[serde(rename = "usageCount")]
    pub usage_count: Option<i32>,
    #[sea_orm(column_type = "Decimal(Some((3, 2)))")]
    #[serde(
        rename = "rating",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub rating: Option<BigDecimal>,
    #[serde(rename = "ratingCount")]
    pub rating_count: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "requiredIntegrations")]
    pub required_integrations: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "version")]
    pub version: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "workflow_templates",
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
            name: "difficulty",
            sql_type: None,
            default: Some(DdlDefault::Sql("'beginner'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_official",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_public",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "usage_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "rating_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "version",
            sql_type: None,
            default: Some(DdlDefault::Sql("'1.0.0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "workflow_templates_category_idx",
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
            name: "workflow_templates_is_public_idx",
            columns: &[IndexColumn {
                expression: "is_public",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workflow_templates_is_official_idx",
            columns: &[IndexColumn {
                expression: "is_official",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workflow_templates_author_idx",
            columns: &[IndexColumn {
                expression: "author_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workflow_templates_usage_idx",
            columns: &[IndexColumn {
                expression: "usage_count",
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
