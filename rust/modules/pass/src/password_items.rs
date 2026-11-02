//! Password-manager items (`password-items.ts`): logins, secure notes and
//! cards, each sealed whole as its JSON document. The plain columns are
//! derived from that document on every write, for lists and page matching.
//! Callers resolve vault access first.

use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_kit::generate_id;

use crate::envelope::{ItemLocation, Key, SealedItem, open_item, seal_item};
use crate::schemas::{ItemDocument, host_of, parse_item};
use crate::totp::{TotpCode, parse_totp, totp_code};
use crate::{PassError, PassResult, dated, now};

const LIST_LIMIT: i64 = 5000;
const INSERT_CHUNK: usize = 100;

macro_rules! item_json {
    () => {
        "jsonb_build_object('id', i.id, 'vaultId', i.vault_id, 'type', i.type, 'title', i.title, \
         'subtitle', i.subtitle, 'url', i.url, 'host', i.host, 'hasTotp', i.has_totp, \
         'passwordChangedAt', i.password_changed_at, 'version', i.version, \
         'createdBy', i.created_by, 'updatedBy', i.updated_by, 'createdAt', i.created_at, \
         'updatedAt', i.updated_at)"
    };
}

const TIMES: [&str; 3] = ["passwordChangedAt", "createdAt", "updatedAt"];

/// `ItemSummary`: nothing in it is secret.
#[derive(Debug, Clone)]
pub(crate) struct Item {
    pub(crate) id: String,
    pub(crate) vault_id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) version: i64,
    pub(crate) json: Value,
}

impl Item {
    pub(crate) fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            vault_id: text("vaultId"),
            kind: text("type"),
            title: text("title"),
            version: row["version"].as_i64().unwrap_or_default(),
            json: row,
        }
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
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        item_json!(),
        " from weldpass_items i where i.vault_id = any($1) and i.deleted_at is null \
         and ($2::text is null or i.type = $2) order by i.title asc limit $3"
    ))
    .bind(vault_ids)
    .bind(kind)
    .bind(LIST_LIMIT)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| Item::from_row(row).json)
        .collect())
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
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        item_json!(),
        " from weldpass_items i where i.vault_id = any($1) and i.type = 'login' and i.deleted_at is null \
         and (i.host = any($2) or ($3 and i.host like $4)) order by i.title asc limit 50"
    ))
    .bind(vault_ids)
    .bind(&parents)
    .bind(labels.len() >= 2)
    .bind(&pattern)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| Item::from_row(row).json)
        .collect())
}

/// `requireItem`.
pub(crate) async fn require_item(db: &PgPool, vault_id: &str, item_id: &str) -> PassResult<Item> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        item_json!(),
        " from weldpass_items i where i.id = $1 and i.vault_id = $2 and i.deleted_at is null limit 1"
    ))
    .bind(item_id)
    .bind(vault_id)
    .fetch_optional(db)
    .await?;
    row.map(Item::from_row)
        .ok_or_else(|| PassError::not_found("item", item_id))
}

async fn require_sealed_item(
    db: &PgPool,
    vault_id: &str,
    item_id: &str,
) -> PassResult<(Item, String, String)> {
    let row: Option<(Value, String, String)> = sqlx::query_as(concat!(
        "select ",
        item_json!(),
        ", i.ciphertext, i.dek_wrapped from weldpass_items i \
         where i.id = $1 and i.vault_id = $2 and i.deleted_at is null limit 1"
    ))
    .bind(item_id)
    .bind(vault_id)
    .fetch_optional(db)
    .await?;
    let (row, ciphertext, dek_wrapped) =
        row.ok_or_else(|| PassError::not_found("item", item_id))?;
    Ok((Item::from_row(row), ciphertext, dek_wrapped))
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
        password_changed_at: Option<String>,
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
            password_changed_at: (!document.password().is_empty()).then(|| now.clone()),
            id,
        });
    }

    let mut created = Vec::with_capacity(rows.len());
    for chunk in rows.chunks(INSERT_CHUNK) {
        let column = |f: fn(&Row) -> Option<String>| chunk.iter().map(f).collect::<Vec<_>>();
        let ids = column(|r| Some(r.id.clone()));
        let kinds = column(|r| Some(r.kind.to_owned()));
        let titles = column(|r| Some(r.derived.title.clone()));
        let subtitles = column(|r| r.derived.subtitle.clone());
        let urls = column(|r| r.derived.url.clone());
        let hosts = column(|r| r.derived.host.clone());
        let totps: Vec<bool> = chunk.iter().map(|r| r.derived.has_totp).collect();
        let ciphertexts = column(|r| Some(r.sealed.ciphertext.clone()));
        let deks = column(|r| Some(r.sealed.dek_wrapped.clone()));
        let changed = column(|r| r.password_changed_at.clone());
        let inserted: Vec<Value> = sqlx::query_scalar(concat!(
            "with i as (insert into weldpass_items (id, vault_id, type, title, subtitle, url, host, \
             has_totp, ciphertext, dek_wrapped, password_changed_at, version, created_by, updated_by) \
             select u.id, $2, u.type, u.title, u.subtitle, u.url, u.host, u.has_totp, u.ciphertext, \
             u.dek_wrapped, u.changed::timestamptz, 1, $12, $12 \
             from unnest($1::varchar[], $3::varchar[], $4::varchar[], $5::varchar[], $6::text[], \
             $7::varchar[], $8::boolean[], $9::text[], $10::text[], $11::text[]) with ordinality \
             as u(id, type, title, subtitle, url, host, has_totp, ciphertext, dek_wrapped, changed, n) \
             order by u.n returning *) select ",
            item_json!(),
            " from i"
        ))
        .bind(&ids)
        .bind(vault_id)
        .bind(&kinds)
        .bind(&titles)
        .bind(&subtitles)
        .bind(&urls)
        .bind(&hosts)
        .bind(&totps)
        .bind(&ciphertexts)
        .bind(&deks)
        .bind(&changed)
        .bind(actor_id)
        .fetch_all(db)
        .await?;
        created.extend(inserted.into_iter().map(Item::from_row));

        let version_ids = column(|_| Some(generate_id("wph")));
        sqlx::query(
            "insert into weldpass_item_versions (id, item_id, vault_id, version, action, ciphertext, \
             dek_wrapped, created_by) \
             select u.id, u.item_id, $3, 1, 'created', u.ciphertext, u.dek_wrapped, $6 \
             from unnest($1::varchar[], $2::varchar[], $4::text[], $5::text[]) with ordinality \
             as u(id, item_id, ciphertext, dek_wrapped, n) order by u.n",
        )
        .bind(&version_ids)
        .bind(&ids)
        .bind(vault_id)
        .bind(&ciphertexts)
        .bind(&deks)
        .bind(actor_id)
        .execute(db)
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
    let next = existing.version + 1;
    let now = now();
    // History first: the other order could lose the only copy of a value.
    sqlx::query(
        "insert into weldpass_item_versions (id, item_id, vault_id, version, action, ciphertext, \
         dek_wrapped, created_by) values ($1, $2, $3, $4::integer, $5, $6, $7, $8)",
    )
    .bind(generate_id("wph"))
    .bind(item_id)
    .bind(vault_id)
    .bind(next)
    .bind(action)
    .bind(&sealed.ciphertext)
    .bind(&sealed.dek_wrapped)
    .bind(actor_id)
    .execute(db)
    .await?;
    let password_changed_at = if password_changed {
        Some(now.clone())
    } else {
        existing.password_changed_at().map(str::to_owned)
    };
    let row: Value = sqlx::query_scalar(concat!(
        "with i as (update weldpass_items set title = $2, subtitle = $3, url = $4, host = $5, \
         has_totp = $6, ciphertext = $7, dek_wrapped = $8, password_changed_at = $9::timestamptz, \
         version = $10::integer, updated_by = $11, updated_at = $12::timestamptz \
         where id = $1 returning *) select ",
        item_json!(),
        " from i"
    ))
    .bind(item_id)
    .bind(&derived.title)
    .bind(derived.subtitle.as_deref())
    .bind(derived.url.as_deref())
    .bind(derived.host.as_deref())
    .bind(derived.has_totp)
    .bind(&sealed.ciphertext)
    .bind(&sealed.dek_wrapped)
    .bind(password_changed_at)
    .bind(next)
    .bind(actor_id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    Ok(Updated {
        item: Item::from_row(row),
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
    sqlx::query(
        "update weldpass_items set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, \
         updated_by = $3 where id = $1",
    )
    .bind(item_id)
    .bind(&now)
    .bind(actor_id)
    .execute(db)
    .await?;
    sqlx::query(
        "insert into weldpass_item_versions (id, item_id, vault_id, version, action, ciphertext, \
         dek_wrapped, created_by) values ($1, $2, $3, $4::integer, 'deleted', $5, $6, $7)",
    )
    .bind(generate_id("wph"))
    .bind(item_id)
    .bind(vault_id)
    .bind(item.version + 1)
    .bind(&ciphertext)
    .bind(&dek_wrapped)
    .bind(actor_id)
    .execute(db)
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
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', v.id, 'version', v.version, 'action', v.action, \
         'createdBy', v.created_by, 'createdAt', v.created_at) from weldpass_item_versions v \
         where v.item_id = $1 order by v.version desc limit 50",
    )
    .bind(item_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| dated(row, &["createdAt"]))
        .collect())
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
    let target: Option<(String, String)> = sqlx::query_as(
        "select ciphertext, dek_wrapped from weldpass_item_versions where item_id = $1 and version = $2 limit 1",
    )
    .bind(item_id)
    .bind(version)
    .fetch_optional(db)
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
    let ids: Vec<String> = keys.iter().map(|(id, _)| id.clone()).collect();
    let rows: Vec<(Value, String, String)> = sqlx::query_as(concat!(
        "select ",
        item_json!(),
        ", i.ciphertext, i.dek_wrapped from weldpass_items i where i.vault_id = any($1) \
         and i.type = 'login' and i.deleted_at is null order by i.title asc limit $2"
    ))
    .bind(&ids)
    .bind(LIST_LIMIT)
    .fetch_all(db)
    .await?;
    let mut opened = Vec::with_capacity(rows.len());
    for (row, ciphertext, dek_wrapped) in rows {
        let item = Item::from_row(row);
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
