//! `social_analytics`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "social_analytics")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "postId")]
    pub post_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "platformPostId")]
    pub platform_post_id: Option<String>,
    #[serde(rename = "snapshotPeriod")]
    pub snapshot_period: super::enums::SocialAnalyticsSnapshotPeriod,
    #[serde(rename = "snapshotAt", with = "crate::js::timestamp")]
    pub snapshot_at: TimeDateTime,
    #[serde(rename = "impressions")]
    pub impressions: Option<i64>,
    #[serde(rename = "reach")]
    pub reach: Option<i64>,
    #[serde(rename = "likes")]
    pub likes: Option<i32>,
    #[serde(rename = "comments")]
    pub comments: Option<i32>,
    #[serde(rename = "shares")]
    pub shares: Option<i32>,
    #[serde(rename = "saves")]
    pub saves: Option<i32>,
    #[serde(rename = "videoViews")]
    pub video_views: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "videoAnalytics")]
    pub video_analytics: Option<Json>,
    #[serde(rename = "clicks")]
    pub clicks: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "clickBreakdown")]
    pub click_breakdown: Option<Json>,
    #[serde(rename = "engagementRate", with = "crate::js::real::option")]
    pub engagement_rate: Option<f32>,
    #[serde(rename = "clickThroughRate", with = "crate::js::real::option")]
    pub click_through_rate: Option<f32>,
    #[serde(rename = "totalEngagement")]
    pub total_engagement: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "engagementBreakdown")]
    pub engagement_breakdown: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "reachBreakdown")]
    pub reach_breakdown: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "audienceDemographics")]
    pub audience_demographics: Option<Json>,
    #[serde(rename = "followsFromPost")]
    pub follows_from_post: Option<i32>,
    #[serde(rename = "profileVisits")]
    pub profile_visits: Option<i32>,
    #[serde(rename = "storyReplies")]
    pub story_replies: Option<i32>,
    #[serde(rename = "storyExits")]
    pub story_exits: Option<i32>,
    #[serde(rename = "storyTapsForward")]
    pub story_taps_forward: Option<i32>,
    #[serde(rename = "storyTapsBack")]
    pub story_taps_back: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "hashtagReach")]
    pub hashtag_reach: Option<Json>,
    #[serde(rename = "peakEngagementHour")]
    pub peak_engagement_hour: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "rawData")]
    pub raw_data: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "social_analytics",
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
            name: "snapshot_period",
            sql_type: None,
            default: Some(DdlDefault::Sql("'lifetime'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "impressions",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "reach",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "likes",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "comments",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "shares",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "saves",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "video_views",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "clicks",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_engagement",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "follows_from_post",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "profile_visits",
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
            name: "social_analytics_post_idx",
            columns: &[IndexColumn {
                expression: "post_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_analytics_account_idx",
            columns: &[IndexColumn {
                expression: "account_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_analytics_snapshot_at_idx",
            columns: &[IndexColumn {
                expression: "snapshot_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_analytics_period_idx",
            columns: &[IndexColumn {
                expression: "snapshot_period",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[
        ForeignKey {
            name: "social_analytics_post_id_social_posts_id_fk",
            columns: &["post_id"],
            references: "social_posts",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
        ForeignKey {
            name: "social_analytics_account_id_social_accounts_id_fk",
            columns: &["account_id"],
            references: "social_accounts",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
    ],
    uniques: &[Unique {
        name: "social_analytics_unique_snapshot",
        columns: &["post_id", "account_id", "snapshot_period", "snapshot_at"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
