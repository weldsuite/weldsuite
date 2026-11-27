//! Which legal entities a search may return the records of.
//!
//! WeldBooks records belong to one legal entity, and a member sees an entity
//! only as the legal-entities crate says (ADR SEC-015: owners see all; a
//! listed member sees the entity; anyone else sees it unless it is
//! restricted). Cmd+K spans entities, so a search over entity-owned records
//! filters on [`entity_scope`] instead of reading every entity's rows.
//!
//! The rule itself is the crate's (`load_entity_access`,
//! `visible_entity_filter`, `entity_scope_condition`); nothing here decides who
//! sees what.

use sea_orm::DbErr;
use weldsuite_db::PgPool;
use weldsuite_legal_entities::{
    EntityScopeCondition, LegalEntityApp, default_entity_id_for, entity_scope_condition,
    load_entity_access, visible_entity_filter,
};
use weldsuite_permissions::Permissions;

/// The condition on an entity column for what `user_id` may see, from their
/// workspace permissions: no filter when nothing is hidden from them, else the
/// visible entities. A row with no entity counts as the default entity's, as
/// everywhere (`entity_scope_condition`). Nobody (no user, no permissions)
/// sees nothing.
///
/// Apply it with `scope.condition(Column::EntityId)`.
pub(crate) async fn entity_scope(
    db: &PgPool,
    user_id: Option<&str>,
    permissions: Option<&Permissions>,
) -> Result<EntityScopeCondition, DbErr> {
    let (Some(user_id), Some(permissions)) = (user_id, permissions) else {
        return Ok(EntityScopeCondition::Nothing);
    };
    let access = load_entity_access(db, user_id, permissions.resolved().clone()).await?;
    let default = default_entity_id_for(db, Some(LegalEntityApp::Weldbooks)).await?;
    Ok(entity_scope_condition(
        visible_entity_filter(&access).as_deref(),
        default.as_deref(),
    ))
}
