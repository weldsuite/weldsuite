//! The access rules (`weldsuite_know_domain::access`, shared with the public
//! API) for know-api's callers, who always have a user.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_know_domain::access as domain;
pub(crate) use weldsuite_know_domain::access::{
    SpaceAccess, add_everyone_to_space, add_space_member, assert_can_manage, assert_can_write,
    ensure_personal_space, join_default_spaces, join_space, list_space_members, list_teammates,
    remove_space_member, set_space_member_role, text,
};

use crate::KnowError;

/// A live space for this caller, or a 404 (`requireSpace`).
pub(crate) async fn require_space(
    db: &PgPool,
    user_id: &str,
    space_id: &str,
    can_manage_all: bool,
) -> Result<SpaceAccess, KnowError> {
    domain::require_space(db, Some(user_id), space_id, can_manage_all).await
}

/// Every space the caller can see (`listSpaces`).
pub(crate) async fn list_spaces(
    db: &PgPool,
    user_id: &str,
    can_manage_all: bool,
) -> Result<Vec<Value>, KnowError> {
    domain::list_spaces(db, Some(user_id), can_manage_all).await
}

/// Ids of the spaces whose pages the caller may read (`readableSpaceIds`).
pub(crate) async fn readable_space_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, KnowError> {
    domain::readable_space_ids(db, Some(user_id)).await
}

/// Ids of the spaces the caller may write pages in (`writableSpaceIds`).
pub(crate) async fn writable_space_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, KnowError> {
    domain::writable_space_ids(db, Some(user_id)).await
}
