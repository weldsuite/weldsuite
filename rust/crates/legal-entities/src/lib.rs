//! Legal entities: the companies of a workspace, owned by the core platform
//! and shared by WeldBooks and WeldHR. The Rust port of
//! `@weldsuite/core-domain/legal-entities` (`packages/domains/core/src/legal-entities`);
//! design in `docs/plans/legal-entities.md`.
//!
//! | Module | TypeScript | What |
//! |---|---|---|
//! | [`access`] | `access.ts` | who sees which entity, and the role they act with there |
//! | [`extensions`] | `extensions.ts` | per app: enabled for, holds data, locks core changes |
//! | [`middleware`] | `middleware.ts` | `legalEntityContext()` as a tower layer, and the request helpers |
//! | [`guard`] | books-api `lib/entity-access.ts`, hr-api `entity-scope.ts` | 404 for a record of an entity the request may not touch |
//! | [`service`] | `service.ts` | entities, registrations, bank accounts, access management |
//! | [`schemas`] | `@weldsuite/app-api-client/schemas/legal-entities` | the request bodies, read as Zod reads them |
//!
//! A module mounts [`legal_entity_context`] on its router behind the session
//! and tenant layers, reads the request's [`RequestEntity`] in its handlers,
//! and guards by-id routes with [`EntityRecordGuard`]. Service functions take
//! the tenant pool and answer [`LegalEntityError`] with TypeScript's codes and
//! messages.

pub mod access;
pub mod extensions;
pub mod guard;
pub mod middleware;
pub mod schemas;
pub mod service;

pub use access::{
    EntityAccess, EntityAccessEntry, EntityAccessRow, EntityAccessSource, LEGAL_ENTITIES_MANAGE,
    build_entity_access, can_see_entity, entity_access_source, entity_role_id, load_entity_access,
    permissions_in_entity, permissions_in_entity_with, resolve_permissions_with_role,
    visible_entity_ids,
};
pub use extensions::{
    LegalEntityApp, LegalEntityCoreChange, enabled_apps_by_entity, locked_core_change,
};
pub use guard::{EntityRecordGuard, EntityRecordGuardLayer, EntityTable, records_in_entity};
pub use middleware::{
    ACCOUNTING_ENTITY_HEADER, EntityScopeCondition, LEGAL_ENTITY_HEADER, LegalEntityContextLayer,
    LegalEntityContextOptions, RequestEntity, default_entity_id_for, entity_scope_condition,
    legal_entity_context, record_in_request_entity, request_entity_id, request_entity_scope,
    requested_entity_id, resolve_request_entity, visible_entity_filter,
};
pub use service::{LegalEntityError, LegalEntityErrorCode};
