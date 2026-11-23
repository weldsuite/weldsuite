//! Password-manager items (`password-items.ts`): logins, secure notes and
//! cards, each sealed whole as its JSON document. The plain columns are
//! derived from that document on every write, for lists and page matching.
//! Callers resolve vault access first.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, Condition, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect, Select, Set,
};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldpass_item_versions as versions, weldpass_items as items};

use crate::envelope::{ItemLocation, Key, SealedItem, open_item, seal_item};
use crate::schemas::{ItemDocument, host_of, parse_item};
use crate::totp::{TotpCode, parse_totp, totp_code};
use crate::{PassError, PassResult, int4, millis, now, row_json};

use items::Column as I;

const LIST_LIMIT: u64 = 5000;
const INSERT_CHUNK: usize = 100;

/// `ItemSummary`'s columns: never the sealed document.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemRow {
    id: String,
    vault_id: String,
    #[sea_orm(from_alias = "type")]
    #[serde(rename = "type")]
    kind: String,
    title: String,
    subtitle: Option<String>,
    url: Option<String>,
    host: Option<String>,
    has_totp: bool,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    password_changed_at: Option<OffsetDateTime>,
    version: i32,
    created_by: Option<String>,
    updated_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl ItemRow {
    fn select() -> Select<items::Entity> {
        items::Entity::find().select_only().columns([
            I::Id,
            I::VaultId,
            I::Type,
            I::Title,
            I::Subtitle,
            I::Url,
            I::Host,
            I::HasTotp,
            I::PasswordChangedAt,
            I::Version,
            I::CreatedBy,
            I::UpdatedBy,
            I::CreatedAt,
            I::UpdatedAt,
        ])
    }
}

impl From<items::Model> for ItemRow {
    fn from(row: items::Model) -> Self {
        Self {
            id: row.id,
            vault_id: row.vault_id,
            kind: row.type_,
            title: row.title,
            subtitle: row.subtitle,
            url: row.url,
            host: row.host,
            has_totp: row.has_totp,
            password_changed_at: row.password_changed_at,
            version: row.version,
            created_by: row.created_by,
            updated_by: row.updated_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `ItemSummary`: nothing in it is secret.
#[derive(Debug, Clone)]
pub(crate) struct Item {
    pub(crate) id: String,
    pub(crate) vault_id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) version: i64,
    pub(crate) json: Value,
    /// `passwordChangedAt` as the worker holds it, a `Date`.
    changed_at: Option<OffsetDateTime>,
}

impl Item {
    fn from_row(row: ItemRow) -> Self {
        Self {
            json: row_json(&row),
            changed_at: row.password_changed_at.map(millis),
            version: i64::from(row.version),
            id: row.id,
            vault_id: row.vault_id,
            kind: row.kind,
            title: row.title,
        }
    }

    /// The row with its sealed document.
    fn sealed(row: items::Model) -> (Self, String, String) {
        let (ciphertext, dek_wrapped) = (row.ciphertext.clone(), row.dek_wrapped.clone());
        (Self::from_row(row.into()), ciphertext, dek_wrapped)
    }

    /// `passwordChangedAt` as `toISOString()`, when set.
    pub(crate) fn password_changed_at(&self) -> Option<&str> {
        self.json["passwordChangedAt"].as_str()
    }
}

/// `ItemFieldError`: answered with 400.
fn field_error(message: &str) -> PassError {
    PassError::BadRequest(message.to_owned())
}

/// The derived columns (`derive`), and the one place the fields are checked.
struct Derived {
    title: String,
    subtitle: Option<String>,
    url: Option<String>,
    host: Option<String>,
    has_totp: bool,
}

fn derive(document: &ItemDocument) -> PassResult<Derived> {
    match document {
        ItemDocument::Login { title, url, fields } => {
            if !fields.totp.is_empty()
                && let Err(error) = parse_totp(&fields.totp)
            {
                return Err(field_error(error.0));
            }
            let url = url
                .as_set()
                .map(|url| crate::js::trim(url).to_owned())
                .filter(|url| !url.is_empty());
            let username = crate::js::trim(&fields.username);
            Ok(Derived {
                title: title.clone(),
                subtitle: (!username.is_empty()).then(|| username.to_owned()),
                host: host_of(url.as_deref()),
                url,
                has_totp: !fields.totp.is_empty(),
            })
        }
        ItemDocument::Card { title, fields } => {
            let digits: Vec<char> = fields.number.chars().filter(char::is_ascii_digit).collect();
            let subtitle = (digits.len() >= 4).then(|| {
                let last: String = digits[digits.len() - 4..].iter().collect();
                format!("•••• {last}")
            });
            Ok(Derived {
                title: title.clone(),
                subtitle,
                url: None,
                host: None,
                has_totp: false,
            })
        }
        ItemDocument::Note { title, .. } => Ok(Derived {
            title: title.clone(),
            subtitle: None,
            url: None,
            host: None,
            has_totp: false,
        }),
    }
}

/// `openDocument`: decrypted and parsed through the schema, so a field added
/// later reads back with its default. A document that does not parse is an
/// unexpected error, as Zod's `parse` throwing is in TypeScript.
fn open_document(
    kek: &Key,
    location: &ItemLocation,
    ciphertext: &str,
    dek_wrapped: &str,
) -> PassResult<ItemDocument> {
    let text = open_item(kek, location, ciphertext, dek_wrapped)?;
    parse_item(&text).ok_or_else(|| PassError::Internal("a stored item does not parse".to_owned()))
}

/// `listItems`: by title, at most 5000.
pub(crate) async fn list_items(
    db: &PgPool,
    vault_ids: &[String],
    kind: Option<&str>,
) -> PassResult<Vec<Value>> {
    if vault_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut select = ItemRow::select()
        .filter(I::VaultId.is_in(vault_ids.iter().map(String::as_str)))
        .filter(I::DeletedAt.is_null());
    if let Some(kind) = kind {
        select = select.filter(I::Type.eq(kind));
    }
    let rows = select
        .order_by_asc(I::Title)
        .limit(LIST_LIMIT)
        .into_model::<ItemRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// `matchLogins`: the same host, a parent of at least two labels, or a
/// subdomain of the page's host.
pub(crate) async fn match_logins(
    db: &PgPool,
    vault_ids: &[String],
    page_host: &str,
) -> PassResult<Vec<Value>> {
    if vault_ids.is_empty() {
        return Ok(Vec::new());
    }
    let labels: Vec<&str> = page_host.split('.').collect();
    let mut parents: Vec<String> = (0..labels.len().saturating_sub(1))
        .map(|i| labels[i..].join("."))
        .collect();
    if parents.is_empty() {
        parents.push(page_host.to_owned());
    }
    // `_` is legal in hostnames and a LIKE wildcard, so it is escaped.
    let mut escaped = String::with_capacity(page_host.len());
    for c in page_host.chars() {
        if matches!(c, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let pattern = format!("%.{escaped}");
    let rows = ItemRow::select()
        .filter(I::VaultId.is_in(vault_ids.iter().map(String::as_str)))
        .filter(I::Type.eq("login"))
        .filter(I::DeletedAt.is_null())
        .filter(
            Condition::any().add(I::Host.is_in(parents)).add(
                Condition::all()
                    .add(Expr::val(labels.len() >= 2))
                    .add(I::Host.like(pattern)),
            ),
        )
        .order_by_asc(I::Title)
        .limit(50)
        .into_model::<ItemRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// `requireItem`.
pub(crate) async fn require_item(db: &PgPool, vault_id: &str, item_id: &str) -> PassResult<Item> {
    let row = ItemRow::select()
        .filter(I::Id.eq(item_id))
        .filter(I::VaultId.eq(vault_id))
        .filter(I::DeletedAt.is_null())
        .into_model::<ItemRow>()
        .one(&orm(db))
        .await?;
    row.map(Item::from_row)
        .ok_or_else(|| PassError::not_found("item", item_id))
}

async fn require_sealed_item(
    db: &PgPool,
    vault_id: &str,
    item_id: &str,
) -> PassResult<(Item, String, String)> {
    let row = items::Entity::find()
        .filter(I::Id.eq(item_id))
        .filter(I::VaultId.eq(vault_id))
        .filter(I::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .ok_or_else(|| PassError::not_found("item", item_id))?;
    Ok(Item::sealed(row))
}

/// `revealItem`: the item and its document.
pub(crate) async fn reveal_item(
    db: &PgPool,
    kek: &Key,
    vault_id: &str,
    item_id: &str,
) -> PassResult<(Item, ItemDocument)> {
    let (item, ciphertext, dek_wrapped) = require_sealed_item(db, vault_id, item_id).await?;
    let document = open_document(
        kek,
        &ItemLocation::new(vault_id, item_id),
        &ciphertext,
        &dek_wrapped,
    )?;
    Ok((item, document))
}

/// `itemTotpCode`: the current code, never the seed.
pub(crate) async fn item_totp_code(
    db: &PgPool,
    kek: &Key,
    vault_id: &str,
    item_id: &str,
) -> PassResult<(Item, TotpCode)> {
    let (item, document) = reveal_item(db, kek, vault_id, item_id).await?;
    let ItemDocument::Login { fields, .. } = &document else {
        return Err(field_error("This item has no two-factor secret."));
    };
    if fields.totp.is_empty() {
        return Err(field_error("This item has no two-factor secret."));
    }
    let config = parse_totp(&fields.totp).map_err(|error| field_error(error.0))?;
    Ok((item, totp_code(&config, OffsetDateTime::now_utc())))
}

/// `createItems`: sealed in memory, inserted 100 at a time, the versions
/// after their items.
pub(crate) async fn create_items(
    db: &PgPool,
    kek: &Key,
    vault_id: &str,
    documents: &[ItemDocument],
    actor_id: &str,
) -> PassResult<Vec<Item>> {
    let now = now();
    #[allow(clippy::items_after_statements)] // a row of this function only
    struct Row {
        id: String,
        kind: &'static str,
        derived: Derived,
        sealed: SealedItem,
        password_changed_at: Option<OffsetDateTime>,
    }
    let mut rows = Vec::with_capacity(documents.len());
    for document in documents {
        let id = generate_id("wpi");
        let sealed = seal_item(
            kek,
            &ItemLocation::new(vault_id, &id),
            &document.to_json_string(),
        )?;
        rows.push(Row {
            kind: document.kind(),
            derived: derive(document)?,
            sealed,
            password_changed_at: (!document.password().is_empty()).then_some(now),
            id,
        });
    }

    let db = orm(db);
    let mut created = Vec::with_capacity(rows.len());
    for chunk in rows.chunks(INSERT_CHUNK) {
        let inserted = items::Entity::insert_many(chunk.iter().map(|row| items::ActiveModel {
            id: Set(row.id.clone()),
            vault_id: Set(vault_id.to_owned()),
            type_: Set(row.kind.to_owned()),
            title: Set(row.derived.title.clone()),
            subtitle: Set(row.derived.subtitle.clone()),
            url: Set(row.derived.url.clone()),
            host: Set(row.derived.host.clone()),
            has_totp: Set(row.derived.has_totp),
            ciphertext: Set(row.sealed.ciphertext.clone()),
            dek_wrapped: Set(row.sealed.dek_wrapped.clone()),
            password_changed_at: Set(row.password_changed_at),
            version: Set(1),
            created_by: Set(Some(actor_id.to_owned())),
            updated_by: Set(Some(actor_id.to_owned())),
            ..Default::default()
        }))
        .exec_with_returning(&db)
        .await?;
        created.extend(
            inserted
                .into_iter()
                .map(|row| Item::from_row(row.into())),
        );

        versions::Entity::insert_many(chunk.iter().map(|row| versions::ActiveModel {
            id: Set(generate_id("wph")),
            item_id: Set(row.id.clone()),
            vault_id: Set(vault_id.to_owned()),
            version: Set(1),
            action: Set("created".to_owned()),
            ciphertext: Set(row.sealed.ciphertext.clone()),
            dek_wrapped: Set(row.sealed.dek_wrapped.clone()),
            created_by: Set(Some(actor_id.to_owned())),
            ..Default::default()
        }))
        .exec_without_returning(&db)
        .await?;
    }
    Ok(created)
}

/// `UpdateItemResult`.
pub(crate) struct Updated {
    pub(crate) item: Item,
    pub(crate) changed: bool,
    pub(crate) password_changed: bool,
}

/// `updateItem`: an identical save is not a new version.
pub(crate) async fn update_item(
    db: &PgPool,
    kek: &Key,
    vault_id: &str,
    item_id: &str,
    document: &ItemDocument,
    actor_id: &str,
    action: &str,
) -> PassResult<Updated> {
    let location = ItemLocation::new(vault_id, item_id);
    let (existing, ciphertext, dek_wrapped) = require_sealed_item(db, vault_id, item_id).await?;
    if existing.kind != document.kind() {
        return Err(field_error(
            "An item cannot change type — create a new one instead.",
        ));
    }
    let derived = derive(document)?;
    let previous = open_document(kek, &location, &ciphertext, &dek_wrapped)?;
    if previous.to_json_string() == document.to_json_string() {
        return Ok(Updated {
            item: existing,
            changed: false,
            password_changed: false,
        });
    }
    let password_changed = previous.password() != document.password();
    let sealed = seal_item(kek, &location, &document.to_json_string())?;
    let next = int4(existing.version + 1)?;
    let now = now();
    let db = orm(db);
    // History first: the other order could lose the only copy of a value.
    versions::Entity::insert(versions::ActiveModel {
        id: Set(generate_id("wph")),
        item_id: Set(item_id.to_owned()),
        vault_id: Set(vault_id.to_owned()),
        version: Set(next),
        action: Set(action.to_owned()),
        ciphertext: Set(sealed.ciphertext.clone()),
        dek_wrapped: Set(sealed.dek_wrapped.clone()),
        created_by: Set(Some(actor_id.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    let password_changed_at = if password_changed {
        Some(now)
    } else {
        existing.changed_at
    };
    let row = items::Entity::update(items::ActiveModel {
        id: Unchanged(item_id.to_owned()),
        title: Set(derived.title),
        subtitle: Set(derived.subtitle),
        url: Set(derived.url),
        host: Set(derived.host),
        has_totp: Set(derived.has_totp),
        ciphertext: Set(sealed.ciphertext),
        dek_wrapped: Set(sealed.dek_wrapped),
        password_changed_at: Set(password_changed_at),
        version: Set(next),
        updated_by: Set(Some(actor_id.to_owned())),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(&db)
    .await?;
    Ok(Updated {
        item: Item::from_row(row.into()),
        changed: true,
        password_changed,
    })
}

/// `deleteItem`: soft, and a `deleted` version.
pub(crate) async fn delete_item(
    db: &PgPool,
    vault_id: &str,
    item_id: &str,
    actor_id: &str,
) -> PassResult<Item> {
    let (item, ciphertext, dek_wrapped) = require_sealed_item(db, vault_id, item_id).await?;
    let now = now();
    let db = orm(db);
    items::Entity::update_many()
        .col_expr(I::DeletedAt, Expr::value(now))
        .col_expr(I::UpdatedAt, Expr::value(now))
        .col_expr(I::UpdatedBy, Expr::value(actor_id))
        .filter(I::Id.eq(item_id))
        .exec(&db)
        .await?;
    versions::Entity::insert(versions::ActiveModel {
        id: Set(generate_id("wph")),
        item_id: Set(item_id.to_owned()),
        vault_id: Set(vault_id.to_owned()),
        version: Set(int4(item.version + 1)?),
        action: Set("deleted".to_owned()),
        ciphertext: Set(ciphertext),
        dek_wrapped: Set(dek_wrapped),
        created_by: Set(Some(actor_id.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(item)
}

/// `moveItem`: re-sealed under the target vault as a new item, the original
/// deleted; its history stays behind.
pub(crate) async fn move_item(
    db: &PgPool,
    source_key: &Key,
    target_key: &Key,
    source_vault: &str,
    target_vault: &str,
    item_id: &str,
    actor_id: &str,
) -> PassResult<(Item, Item)> {
    let (_, document) = reveal_item(db, source_key, source_vault, item_id).await?;
    let moved = create_items(
        db,
        target_key,
        target_vault,
        std::slice::from_ref(&document),
        actor_id,
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| PassError::Internal("the moved item was not created".to_owned()))?;
    let source = delete_item(db, source_vault, item_id, actor_id).await?;
    Ok((source, moved))
}

/// `listItemVersions`: newest first, at most 50.
pub(crate) async fn list_item_versions(db: &PgPool, item_id: &str) -> PassResult<Vec<Value>> {
    use versions::Column as V;
    let rows = versions::Entity::find()
        .select_only()
        .columns([V::Id, V::Version, V::Action, V::CreatedBy, V::CreatedAt])
        .filter(V::ItemId.eq(item_id))
        .order_by_desc(V::Version)
        .limit(50)
        .into_model::<VersionRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// One entry of an item's history: never its sealed document.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionRow {
    id: String,
    version: i32,
    action: String,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// `restoreItemVersion`: the old document opened and saved again.
pub(crate) async fn restore_item_version(
    db: &PgPool,
    kek: &Key,
    vault_id: &str,
    item_id: &str,
    version: i64,
    actor_id: &str,
) -> PassResult<Updated> {
    require_item(db, vault_id, item_id).await?;
    let target: Option<(String, String)> = versions::Entity::find()
        .select_only()
        .columns([versions::Column::Ciphertext, versions::Column::DekWrapped])
        .filter(versions::Column::ItemId.eq(item_id))
        .filter(versions::Column::Version.eq(version))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (ciphertext, dek_wrapped) =
        target.ok_or_else(|| PassError::not_found("item", &format!("{item_id}@v{version}")))?;
    let document = open_document(
        kek,
        &ItemLocation::new(vault_id, item_id),
        &ciphertext,
        &dek_wrapped,
    )?;
    update_item(db, kek, vault_id, item_id, &document, actor_id, "restored").await
}

/// `openLogins`: every login of these vaults, opened in memory for the
/// health report only.
pub(crate) async fn open_logins(
    db: &PgPool,
    keys: &[(String, Key)],
) -> PassResult<Vec<(Item, String)>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let rows = items::Entity::find()
        .filter(I::VaultId.is_in(keys.iter().map(|(id, _)| id.as_str())))
        .filter(I::Type.eq("login"))
        .filter(I::DeletedAt.is_null())
        .order_by_asc(I::Title)
        .limit(LIST_LIMIT)
        .all(&orm(db))
        .await?;
    let mut opened = Vec::with_capacity(rows.len());
    for row in rows {
        let (item, ciphertext, dek_wrapped) = Item::sealed(row);
        let Some((_, kek)) = keys.iter().find(|(id, _)| *id == item.vault_id) else {
            continue;
        };
        let document = open_document(
            kek,
            &ItemLocation::new(&item.vault_id, &item.id),
            &ciphertext,
            &dek_wrapped,
        )?;
        let password = document.password().to_owned();
        opened.push((item, password));
    }
    Ok(opened)
}
