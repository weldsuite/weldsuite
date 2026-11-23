//! Which accounting entity a request is about, and per-entity numbering
//! (`books-api/src/lib/entity-context.ts`), plus the per-entity record
//! checks of `lib/entity-access.ts`.

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_legal_entities::{
    EntityAccess, EntityTable, LegalEntityApp, LegalEntityContextLayer, LegalEntityContextOptions,
    RequestEntity, can_see_entity, legal_entity_context, load_entity_access, requested_entity_id,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{entities, entity_number_sequences, settings};

use crate::http::Caller;

/// `legalEntityContext({ app: 'weldbooks', scoped: true })`'s options, as
/// books-api mounts it on `/api/*` (`src/index.ts`): only entities WeldBooks
/// is enabled for resolve, and inside one the member acts with their entity
/// role.
pub fn books_entity_context_options() -> LegalEntityContextOptions {
    LegalEntityContextOptions::new()
        .app(LegalEntityApp::Weldbooks)
        .scoped()
}

/// The books layer for a router of books routes: add it with `.layer(...)`
/// (so it runs before the routes' gates and record guards), behind the
/// session and tenant layers. Every books `/api` router mounts it, as every
/// books-api `/api/*` request goes through `legalEntityContext()`; only the
/// accounting-entities list and create skip it (`weldsuite-books`).
pub fn books_entity_context<Q>(gate: &Arc<PermissionGate<Q>>) -> LegalEntityContextLayer<Q>
where
    Q: PermissionQueries + 'static,
{
    legal_entity_context(gate, books_entity_context_options())
}

/// `resolveEntityId(c, db)`: the entity this request targets. Resolved once
/// per request.
///
/// Behind `legal_entity_context` (every `/api` request of books) that is the
/// layer's answer: `X-Legal-Entity-Id`, `X-Accounting-Entity-Id`,
/// `?entityId`, else the default entity, checked against the member's access
/// and WeldBooks being enabled for it. An entity that is unknown, deleted, not
/// visible or not in WeldBooks resolves to `None`, so the route refuses or
/// lists nothing instead of writing under an entity that isn't there.
///
/// Without the layer (cron, internal routes) the old resolution applies: the
/// `X-Accounting-Entity-Id` header, `?entityId=`, then the workspace default
/// (`settings.defaultEntityId`); the id must name an entity of this workspace
/// that isn't deleted.
pub async fn resolve_entity_id(caller: &Caller) -> Result<Option<String>, DbErr> {
    caller
        .entity
        .get_or_try_init(|| resolve_uncached(caller))
        .await
        .cloned()
}

async fn resolve_uncached(caller: &Caller) -> Result<Option<String>, DbErr> {
    if let Some(request) = &caller.legal_entity {
        return Ok(request.entity_id().map(str::to_owned));
    }
    // `c.req.header('x-accounting-entity-id') || c.req.query('entityId')`
    let requested = caller
        .header("x-accounting-entity-id")
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .or_else(|| caller.query().get("entityId").map(str::to_owned))
        .filter(|id| !id.is_empty());
    if let Some(requested) = requested {
        return Ok(entity_exists(&caller.db, &requested)
            .await?
            .then_some(requested));
    }
    let fallback: Option<Option<String>> = settings::Entity::find()
        .select_only()
        .column(settings::Column::DefaultEntityId)
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    match fallback.flatten().filter(|id| !id.is_empty()) {
        Some(id) => Ok(entity_exists(&caller.db, &id).await?.then_some(id)),
        None => Ok(None),
    }
}

/// `resolveRequestedEntityId(c, db, requested)`: the entity a write targets
/// when the body may name one. A named id only when it is a live entity the
/// member sees and may act in with the role this request was checked with
/// ([`record_in_request_entity`]), else `None`; without a named entity, what
/// [`resolve_entity_id`] resolves. A request without a member (a trusted
/// internal caller) gets any live entity it names.
pub async fn resolve_requested_entity_id(
    caller: &Caller,
    requested: Option<&str>,
) -> Result<Option<String>, DbErr> {
    let Some(id) = requested.filter(|id| !id.is_empty()) else {
        return resolve_entity_id(caller).await;
    };
    if !entity_exists(&caller.db, id).await? {
        return Ok(None);
    }
    if caller.user().is_none() {
        return Ok(Some(id.to_owned()));
    }
    let request = request_entity(caller).await?;
    if !can_see_entity(request.access(), Some(id)) {
        return Ok(None);
    }
    Ok(
        weldsuite_legal_entities::record_in_request_entity(&request, Some(id))
            .then(|| id.to_owned()),
    )
}

/// `getEntityAccess(c)`: the member's access snapshot. The layer's when it
/// ran; otherwise loaded once from the request's (workspace) permissions.
pub async fn entity_access(caller: &Caller) -> Result<Arc<EntityAccess>, DbErr> {
    if let Some(request) = &caller.legal_entity {
        return Ok(request.access_arc());
    }
    caller
        .entity_access
        .get_or_try_init(|| async {
            load_entity_access(
                &caller.db,
                &caller.user_id,
                caller.permissions.resolved().clone(),
            )
            .await
            .map(Arc::new)
        })
        .await
        .cloned()
}

/// The request as the per-entity checks see it: what `legal_entity_context`
/// settled, or, for a request it did not settle, the member's access with no
/// resolved entity (`getRequestEntityId(c)` is `undefined` there).
pub async fn request_entity(caller: &Caller) -> Result<RequestEntity, DbErr> {
    if let Some(request) = &caller.legal_entity {
        return Ok(request.clone());
    }
    let access = entity_access(caller).await?;
    Ok(RequestEntity::unresolved(
        access,
        requested_entity_id(caller.headers(), caller.raw_query()),
    ))
}

/// `recordInRequestEntity(c, recordEntityId)`: may this request touch a
/// record of that entity? Answer 404 when it may not.
pub async fn record_in_request_entity(
    caller: &Caller,
    record_entity_id: Option<&str>,
) -> Result<bool, DbErr> {
    let request = request_entity(caller).await?;
    Ok(weldsuite_legal_entities::record_in_request_entity(
        &request,
        record_entity_id,
    ))
}

/// `recordsInEntity(c, table, ids)`: whether every record (by id) of
/// `table` belongs to an entity the request may touch. Unknown ids pass;
/// no query is made for members whose access is the same everywhere, or for
/// a request without a member.
pub async fn records_in_entity(
    caller: &Caller,
    table: &EntityTable,
    ids: &[&str],
) -> Result<bool, DbErr> {
    if caller.user().is_none() {
        return Ok(true);
    }
    let request = request_entity(caller).await?;
    weldsuite_legal_entities::records_in_entity(&caller.db, &request, table, ids).await
}

/// `entityExists(db, id)`: an accounting entity of this workspace that isn't
/// deleted.
pub async fn entity_exists(db: &PgPool, entity_id: &str) -> Result<bool, DbErr> {
    let row: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::Id)
        .filter(entities::Column::Id.eq(entity_id))
        .filter(entities::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

/// `resolveEntityBaseCurrency(db, entityId)`: `entity?.baseCurrency || 'EUR'`.
pub async fn resolve_entity_base_currency(db: &PgPool, entity_id: &str) -> Result<String, DbErr> {
    let currency: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::BaseCurrency)
        .filter(entities::Column::Id.eq(entity_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(currency
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "EUR".to_owned()))
}

/// The kinds of per-entity numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceType {
    Invoice,
    Bill,
    CreditNote,
    Journal,
}

impl SequenceType {
    /// The `sequence_type` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invoice => "invoice",
            Self::Bill => "bill",
            Self::CreditNote => "creditNote",
            Self::Journal => "journal",
        }
    }

    /// `DEFAULT_SEQUENCE_PREFIX`.
    pub fn default_prefix(self) -> &'static str {
        match self {
            Self::Invoice => "INV-",
            Self::Bill => "BILL-",
            Self::CreditNote => "CN-",
            Self::Journal => "JE-",
        }
    }
}

/// One allocated number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityNumber {
    pub value: i64,
    pub prefix: String,
    pub padding: i64,
    /// `${prefix}${String(value).padStart(padding, '0')}`.
    pub formatted: String,
}

/// `nextEntityNumber(db, entityId, type)`: the next number of a per-entity
/// sequence, allocated race-free by one upsert (gapless numbering is a legal
/// requirement for Dutch invoices).
pub async fn next_entity_number(
    db: &PgPool,
    entity_id: &str,
    sequence: SequenceType,
) -> Result<EntityNumber, DbErr> {
    use entity_number_sequences::{ActiveModel, Column, Entity};
    use sea_orm::ExprTrait as _;
    let row = Entity::insert(ActiveModel {
        id: Set(generate_id("seq")),
        entity_id: Set(entity_id.to_owned()),
        sequence_type: Set(sequence.as_str().to_owned()),
        prefix: Set(sequence.default_prefix().to_owned()),
        next_value: Set(2),
        padding: Set(Some(4)),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([Column::EntityId, Column::SequenceType])
            .value(
                Column::NextValue,
                Expr::col((Entity, Column::NextValue)).add(1),
            )
            .value(Column::UpdatedAt, utc_now())
            .to_owned(),
    )
    .exec_with_returning(&orm(db))
    .await?;
    let value = i64::from(row.next_value) - 1;
    let prefix = row.prefix;
    let padding = i64::from(row.padding.unwrap_or(0));
    let digits = value.to_string();
    let width = usize::try_from(padding).unwrap_or(0);
    let formatted = format!("{prefix}{digits:0>width$}");
    Ok(EntityNumber {
        value,
        prefix,
        padding,
        formatted,
    })
}
