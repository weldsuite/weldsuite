//! The Postgres enums of the master database.

use sea_orm::entity::prelude::*;

/// `admin_role`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "admin_role")]
pub enum AdminRole {
    #[sea_orm(string_value = "superadmin")]
    #[serde(rename = "superadmin")]
    Superadmin,
    #[sea_orm(string_value = "admin")]
    #[serde(rename = "admin")]
    Admin,
    #[sea_orm(string_value = "viewer")]
    #[serde(rename = "viewer")]
    Viewer,
}

/// `database_pool_status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(
    rs_type = "String",
    db_type = "Enum",
    enum_name = "database_pool_status"
)]
pub enum DatabasePoolStatus {
    #[sea_orm(string_value = "available")]
    #[serde(rename = "available")]
    Available,
    #[sea_orm(string_value = "assigned")]
    #[serde(rename = "assigned")]
    Assigned,
    #[sea_orm(string_value = "error")]
    #[serde(rename = "error")]
    Error,
}

/// `feature_status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "feature_status")]
pub enum FeatureStatus {
    #[sea_orm(string_value = "open")]
    #[serde(rename = "open")]
    Open,
    #[sea_orm(string_value = "under_review")]
    #[serde(rename = "under_review")]
    UnderReview,
    #[sea_orm(string_value = "planned")]
    #[serde(rename = "planned")]
    Planned,
    #[sea_orm(string_value = "in_progress")]
    #[serde(rename = "in_progress")]
    InProgress,
    #[sea_orm(string_value = "completed")]
    #[serde(rename = "completed")]
    Completed,
    #[sea_orm(string_value = "declined")]
    #[serde(rename = "declined")]
    Declined,
}

/// `feature_type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "feature_type")]
pub enum FeatureType {
    #[sea_orm(string_value = "feature")]
    #[serde(rename = "feature")]
    Feature,
    #[sea_orm(string_value = "bug")]
    #[serde(rename = "bug")]
    Bug,
    #[sea_orm(string_value = "improvement")]
    #[serde(rename = "improvement")]
    Improvement,
}

/// `inquiry_status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "inquiry_status")]
pub enum InquiryStatus {
    #[sea_orm(string_value = "new")]
    #[serde(rename = "new")]
    New,
    #[sea_orm(string_value = "contacted")]
    #[serde(rename = "contacted")]
    Contacted,
    #[sea_orm(string_value = "in_progress")]
    #[serde(rename = "in_progress")]
    InProgress,
    #[sea_orm(string_value = "closed")]
    #[serde(rename = "closed")]
    Closed,
    #[sea_orm(string_value = "converted")]
    #[serde(rename = "converted")]
    Converted,
}

/// `membership_status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "membership_status")]
pub enum MembershipStatus {
    #[sea_orm(string_value = "ACTIVE")]
    #[serde(rename = "ACTIVE")]
    ACTIVE,
    #[sea_orm(string_value = "PENDING")]
    #[serde(rename = "PENDING")]
    PENDING,
}

/// `neon_shared_project_status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(
    rs_type = "String",
    db_type = "Enum",
    enum_name = "neon_shared_project_status"
)]
pub enum NeonSharedProjectStatus {
    #[sea_orm(string_value = "active")]
    #[serde(rename = "active")]
    Active,
    #[sea_orm(string_value = "full")]
    #[serde(rename = "full")]
    Full,
    #[sea_orm(string_value = "disabled")]
    #[serde(rename = "disabled")]
    Disabled,
}

/// `tenant_tier`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]
#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "tenant_tier")]
pub enum TenantTier {
    #[sea_orm(string_value = "free")]
    #[serde(rename = "free")]
    Free,
    #[sea_orm(string_value = "business")]
    #[serde(rename = "business")]
    Business,
    #[sea_orm(string_value = "scale")]
    #[serde(rename = "scale")]
    Scale,
    #[sea_orm(string_value = "enterprise")]
    #[serde(rename = "enterprise")]
    Enterprise,
}

/// Every enum of the database, for the snapshot.
pub fn all() -> Vec<crate::snapshot::EnumSchema> {
    vec![
        crate::snapshot::enum_schema::<AdminRole>(),
        crate::snapshot::enum_schema::<DatabasePoolStatus>(),
        crate::snapshot::enum_schema::<FeatureStatus>(),
        crate::snapshot::enum_schema::<FeatureType>(),
        crate::snapshot::enum_schema::<InquiryStatus>(),
        crate::snapshot::enum_schema::<MembershipStatus>(),
        crate::snapshot::enum_schema::<NeonSharedProjectStatus>(),
        crate::snapshot::enum_schema::<TenantTier>(),
    ]
}
