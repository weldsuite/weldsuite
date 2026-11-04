//! Which accounting entity a request is about, and per-entity numbering
//! (`books-api/src/lib/entity-context.ts`).

use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::http::Caller;

/// `resolveEntityId(c, db)`: the entity this request targets, by
/// precedence the `X-Accounting-Entity-Id` header, `?entityId=`, then the
/// workspace default (`settings.defaultEntityId`). The id must name an entity
/// of this workspace that isn't deleted; one that doesn't resolves to `None`.
/// Resolved once per request.
pub async fn resolve_entity_id(caller: &Caller) -> Result<Option<String>, sqlx::Error> {
    caller
        .entity
        .get_or_try_init(|| resolve_uncached(caller))
        .await
        .cloned()
}

async fn resolve_uncached(caller: &Caller) -> Result<Option<String>, sqlx::Error> {
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
    let fallback: Option<Option<String>> =
        sqlx::query_scalar("select default_entity_id from settings limit 1")
            .fetch_optional(&caller.db)
            .await?;
    match fallback.flatten().filter(|id| !id.is_empty()) {
        Some(id) => Ok(entity_exists(&caller.db, &id).await?.then_some(id)),
        None => Ok(None),
    }
}

/// `resolveRequestedEntityId(c, db, requested)`: the id a body names when it
/// names one (and it exists here), else [`resolve_entity_id`].
pub async fn resolve_requested_entity_id(
    caller: &Caller,
    requested: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    match requested.filter(|id| !id.is_empty()) {
        Some(id) => Ok(entity_exists(&caller.db, id).await?.then(|| id.to_owned())),
        None => resolve_entity_id(caller).await,
    }
}

/// `entityExists(db, id)`: an accounting entity of this workspace that isn't
/// deleted.
pub async fn entity_exists(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<String> =
        sqlx::query_scalar("select id from entities where id = $1 and deleted_at is null limit 1")
            .bind(entity_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// `resolveEntityBaseCurrency(db, entityId)`: `entity?.baseCurrency || 'EUR'`.
pub async fn resolve_entity_base_currency(
    db: &PgPool,
    entity_id: &str,
) -> Result<String, sqlx::Error> {
    let currency: Option<Option<String>> =
        sqlx::query_scalar("select base_currency from entities where id = $1 limit 1")
            .bind(entity_id)
            .fetch_optional(db)
            .await?;
    Ok(currency
        .flatten()
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
pub async fn next_entity_number<'e>(
    db: impl sqlx::PgExecutor<'e>,
    entity_id: &str,
    sequence: SequenceType,
) -> Result<EntityNumber, sqlx::Error> {
    let (next_value, prefix, padding): (i32, Option<String>, Option<i32>) = sqlx::query_as(
        "insert into entity_number_sequences (id, entity_id, sequence_type, prefix, next_value, padding) \
         values ($1, $2, $3, $4, 2, 4) \
         on conflict (entity_id, sequence_type) do update \
         set next_value = entity_number_sequences.next_value + 1, updated_at = $5::timestamp \
         returning next_value, prefix, padding",
    )
    .bind(generate_id("seq"))
    .bind(entity_id)
    .bind(sequence.as_str())
    .bind(sequence.default_prefix())
    .bind(crate::http::now())
    .fetch_one(db)
    .await?;
    let value = i64::from(next_value) - 1;
    let prefix = prefix.unwrap_or_default();
    let padding = i64::from(padding.unwrap_or(0));
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
