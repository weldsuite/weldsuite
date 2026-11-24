//! Secret reads and writes (`services/weldpass/secrets.ts`). Listing never
//! decrypts; only a reveal and an environment read open a value. Every write
//! appends to `weldpass_secret_versions` before the current row changes.
//! Checksums written before they were keyed (a bare SHA-256) are upgraded
//! whenever the plaintext is in hand.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect, Select, Set,
};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldpass_secret_versions as versions, weldpass_secrets as secrets};

use crate::dotenv::is_valid_secret_key;
use crate::envelope::{
    Key, SecretLocation, checksum_for, checksum_matches, is_legacy_checksum, open_secret,
    seal_secret,
};
use crate::js::JsRecord;
use crate::{PassError, PassResult, int4, now, row_json};

use secrets::Column as S;

/// `SecretSummary`'s columns: never the sealed value.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretRow {
    id: String,
    project_id: String,
    environment_id: String,
    key: String,
    note: Option<String>,
    version: i32,
    value_length: i32,
    value_hint: Option<String>,
    checksum: String,
    created_by: Option<String>,
    updated_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl SecretRow {
    fn select() -> Select<secrets::Entity> {
        secrets::Entity::find().select_only().columns([
            S::Id,
            S::ProjectId,
            S::EnvironmentId,
            S::Key,
            S::Note,
            S::Version,
            S::ValueLength,
            S::ValueHint,
            S::Checksum,
            S::CreatedBy,
            S::UpdatedBy,
            S::CreatedAt,
            S::UpdatedAt,
        ])
    }
}

impl From<secrets::Model> for SecretRow {
    fn from(row: secrets::Model) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            environment_id: row.environment_id,
            key: row.key,
            note: row.note,
            version: row.version,
            value_length: row.value_length,
            value_hint: row.value_hint,
            checksum: row.checksum,
            created_by: row.created_by,
            updated_by: row.updated_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `SecretSummary`: what a client sees without `secrets:reveal`.
#[derive(Debug, Clone)]
pub(crate) struct Secret {
    pub(crate) id: String,
    pub(crate) key: String,
    pub(crate) project_id: String,
    pub(crate) version: i64,
    pub(crate) checksum: String,
    pub(crate) json: Value,
    environment_id: String,
}

impl Secret {
    fn from_row(row: SecretRow) -> Self {
        Self {
            json: row_json(&row),
            version: i64::from(row.version),
            id: row.id,
            key: row.key,
            project_id: row.project_id,
            checksum: row.checksum,
            environment_id: row.environment_id,
        }
    }

    fn location(&self) -> SecretLocation {
        SecretLocation::new(&self.project_id, &self.environment_id, &self.key)
    }
}

/// `SecretKeyError`'s message.
fn key_error(key: &str) -> PassError {
    PassError::BadRequest(format!(
        "\"{key}\" is not a usable environment variable name — use letters, digits and underscores, starting with a letter or underscore."
    ))
}

/// `listSecrets`: by key.
pub(crate) async fn list_secrets(db: &PgPool, environment_id: &str) -> PassResult<Vec<Secret>> {
    let rows = SecretRow::select()
        .filter(S::EnvironmentId.eq(environment_id))
        .filter(S::DeletedAt.is_null())
        .order_by_asc(S::Key)
        .into_model::<SecretRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Secret::from_row).collect())
}

/// `requireSecret`.
pub(crate) async fn require_secret(
    db: &PgPool,
    environment_id: &str,
    secret_id: &str,
) -> PassResult<Secret> {
    let row = SecretRow::select()
        .filter(S::Id.eq(secret_id))
        .filter(S::EnvironmentId.eq(environment_id))
        .filter(S::DeletedAt.is_null())
        .into_model::<SecretRow>()
        .one(&orm(db))
        .await?;
    row.map(Secret::from_row)
        .ok_or_else(|| PassError::not_found("secret", secret_id))
}

/// `revealSecret`: the value, upgrading a legacy checksum on the way.
pub(crate) async fn reveal_secret(
    db: &PgPool,
    kek: &Key,
    environment_id: &str,
    secret_id: &str,
) -> PassResult<(Secret, String)> {
    let db = orm(db);
    let row = secrets::Entity::find()
        .filter(S::Id.eq(secret_id))
        .filter(S::EnvironmentId.eq(environment_id))
        .filter(S::DeletedAt.is_null())
        .one(&db)
        .await?
        .ok_or_else(|| PassError::not_found("secret", secret_id))?;
    let (ciphertext, dek_wrapped) = (row.ciphertext.clone(), row.dek_wrapped.clone());
    let mut secret = Secret::from_row(row.into());
    let location = secret.location();
    let value = open_secret(kek, &location, &ciphertext, &dek_wrapped)?;

    // Opportunistic: a failed upgrade must not stop the reveal.
    if is_legacy_checksum(&secret.checksum)
        && let Ok(checksum) = checksum_for(kek, &location, &value)
        && set_checksum(&db, &secret.id, &checksum).await.is_ok()
    {
        secret.json["checksum"] = Value::String(checksum.clone());
        secret.checksum = checksum;
    }
    Ok((secret, value))
}

/// `update weldpass_secrets set checksum = … where id = …`.
async fn set_checksum(db: &DatabaseConnection, id: &str, checksum: &str) -> Result<(), DbErr> {
    secrets::Entity::update_many()
        .col_expr(S::Checksum, Expr::value(checksum))
        .filter(S::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

/// `readEnvironmentValues`: every value, by key, for an export or a push.
pub(crate) async fn read_environment_values(
    db: &PgPool,
    kek: &Key,
    environment_id: &str,
) -> PassResult<JsRecord> {
    let rows: Vec<(String, String, String, String, String)> = secrets::Entity::find()
        .select_only()
        .columns([
            S::ProjectId,
            S::EnvironmentId,
            S::Key,
            S::Ciphertext,
            S::DekWrapped,
        ])
        .filter(S::EnvironmentId.eq(environment_id))
        .filter(S::DeletedAt.is_null())
        .order_by_asc(S::Key)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut values = JsRecord::default();
    // `Promise.all`: every row opens, or the first failure is thrown.
    let mut opened = Vec::with_capacity(rows.len());
    for (project_id, environment, key, ciphertext, dek_wrapped) in &rows {
        let location = SecretLocation::new(project_id, environment, key);
        opened.push((key, open_secret(kek, &location, ciphertext, dek_wrapped)?));
    }
    for (key, value) in opened {
        values.set(key, value);
    }
    Ok(values)
}

/// `UpsertResult`.
pub(crate) struct Upserted {
    pub(crate) secret: Secret,
    pub(crate) created: bool,
    pub(crate) changed: bool,
}

/// `upsertSecret`: create, replace, or (same value, same note) leave alone.
/// `note`: `None` keeps the stored note, `Some(None)` clears it.
#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::option_option
)] // the worker's input object, field by field; `note` is undefined, null or a note
pub(crate) async fn upsert_secret(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    environment_id: &str,
    key: &str,
    value: &str,
    note: Option<Option<&str>>,
    actor_id: &str,
) -> PassResult<Upserted> {
    if !is_valid_secret_key(key) {
        return Err(key_error(key));
    }
    let pool = db;
    let db = orm(pool);
    let existing: Option<(String, i32, String, Option<String>)> = secrets::Entity::find()
        .select_only()
        .columns([S::Id, S::Version, S::Checksum, S::Note])
        .filter(S::EnvironmentId.eq(environment_id))
        .filter(S::Key.eq(key))
        .into_tuple()
        .one(&db)
        .await?;

    let location = SecretLocation::new(project_id, environment_id, key);
    let sealed = seal_secret(kek, &location, value)?;
    let now = now();

    let Some((existing_id, version, checksum, existing_note)) = existing else {
        let id = generate_id("wps");
        let row = secrets::Entity::insert(secrets::ActiveModel {
            id: Set(id.clone()),
            project_id: Set(project_id.to_owned()),
            environment_id: Set(environment_id.to_owned()),
            key: Set(key.to_owned()),
            ciphertext: Set(sealed.ciphertext.clone()),
            dek_wrapped: Set(sealed.dek_wrapped.clone()),
            checksum: Set(sealed.checksum.clone()),
            value_length: Set(sealed.value_length),
            value_hint: Set(sealed.value_hint.clone()),
            note: Set(note.flatten().map(str::to_owned)),
            version: Set(1),
            created_by: Set(Some(actor_id.to_owned())),
            updated_by: Set(Some(actor_id.to_owned())),
            ..Default::default()
        })
        .exec_with_returning(&db)
        .await?;
        append_version(
            &db,
            &id,
            project_id,
            1,
            "created",
            &sealed.ciphertext,
            &sealed.dek_wrapped,
            &sealed.checksum,
            actor_id,
        )
        .await?;
        return Ok(Upserted {
            secret: Secret::from_row(row.into()),
            created: true,
            changed: true,
        });
    };

    let note_changed = note.is_some_and(|note| note != existing_note.as_deref());
    let same_value = checksum_matches(&checksum, &sealed.checksum, value);
    if same_value && !note_changed {
        if is_legacy_checksum(&checksum) {
            set_checksum(&db, &existing_id, &sealed.checksum).await?;
        }
        let secret = require_secret(pool, environment_id, &existing_id).await?;
        return Ok(Upserted {
            secret,
            created: false,
            changed: false,
        });
    }

    let next = int4(i64::from(version) + 1)?;
    // History first: the other order could lose the only copy of a value.
    append_version(
        &db,
        &existing_id,
        project_id,
        next,
        "updated",
        &sealed.ciphertext,
        &sealed.dek_wrapped,
        &sealed.checksum,
        actor_id,
    )
    .await?;
    let note = match note {
        None => existing_note.clone(),
        Some(note) => note.map(str::to_owned),
    };
    let row = secrets::Entity::update(secrets::ActiveModel {
        id: Unchanged(existing_id),
        ciphertext: Set(sealed.ciphertext),
        dek_wrapped: Set(sealed.dek_wrapped),
        checksum: Set(sealed.checksum),
        value_length: Set(sealed.value_length),
        value_hint: Set(sealed.value_hint),
        note: Set(note),
        version: Set(next),
        updated_by: Set(Some(actor_id.to_owned())),
        updated_at: Set(now),
        deleted_at: Set(None),
        ..Default::default()
    })
    .exec(&db)
    .await?;
    Ok(Upserted {
        secret: Secret::from_row(row.into()),
        created: false,
        changed: true,
    })
}

/// `importSecrets`: what was created, updated and left unchanged.
pub(crate) async fn import_secrets(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    environment_id: &str,
    values: &JsRecord,
    actor_id: &str,
) -> PassResult<(Vec<String>, Vec<String>, Vec<String>)> {
    let (mut created, mut updated, mut unchanged) = (Vec::new(), Vec::new(), Vec::new());
    for (key, value) in values.entries() {
        let result = upsert_secret(
            db,
            kek,
            project_id,
            environment_id,
            key,
            value,
            None,
            actor_id,
        )
        .await?;
        if result.created {
            created.push(key.to_owned());
        } else if result.changed {
            updated.push(key.to_owned());
        } else {
            unchanged.push(key.to_owned());
        }
    }
    Ok((created, updated, unchanged))
}

/// `deleteSecret`: soft, and a `deleted` version holding the last value.
pub(crate) async fn delete_secret(
    db: &PgPool,
    environment_id: &str,
    secret_id: &str,
    actor_id: &str,
) -> PassResult<Secret> {
    let secret = require_secret(db, environment_id, secret_id).await?;
    let db = orm(db);
    let current: Option<(String, String)> = secrets::Entity::find()
        .select_only()
        .columns([S::Ciphertext, S::DekWrapped])
        .filter(S::Id.eq(secret_id))
        .into_tuple()
        .one(&db)
        .await?;
    let (ciphertext, dek_wrapped) =
        current.ok_or_else(|| PassError::not_found("secret", secret_id))?;
    let now = now();
    secrets::Entity::update_many()
        .col_expr(S::DeletedAt, Expr::value(now))
        .col_expr(S::UpdatedAt, Expr::value(now))
        .col_expr(S::UpdatedBy, Expr::value(actor_id))
        .filter(S::Id.eq(secret_id))
        .exec(&db)
        .await?;
    append_version(
        &db,
        secret_id,
        &secret.project_id,
        int4(secret.version + 1)?,
        "deleted",
        &ciphertext,
        &dek_wrapped,
        &secret.checksum,
        actor_id,
    )
    .await?;
    Ok(secret)
}

/// `listVersions`: newest first, at most 50.
pub(crate) async fn list_versions(db: &PgPool, secret_id: &str) -> PassResult<Vec<Value>> {
    use versions::Column as V;
    let rows = versions::Entity::find()
        .select_only()
        .columns([
            V::Id,
            V::Version,
            V::Action,
            V::Checksum,
            V::CreatedBy,
            V::CreatedAt,
        ])
        .filter(V::SecretId.eq(secret_id))
        .order_by_desc(V::Version)
        .limit(50)
        .into_model::<VersionRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// One entry of a secret's history: never its sealed value.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionRow {
    id: String,
    version: i32,
    action: String,
    checksum: String,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// `restoreVersion`: the old ciphertext reused as it is (it is bound to the
/// same location, so it still opens).
pub(crate) async fn restore_version(
    db: &PgPool,
    environment_id: &str,
    secret_id: &str,
    version: i64,
    actor_id: &str,
) -> PassResult<Secret> {
    let secret = require_secret(db, environment_id, secret_id).await?;
    let db = orm(db);
    let target: Option<(String, String, String)> = versions::Entity::find()
        .select_only()
        .columns([
            versions::Column::Ciphertext,
            versions::Column::DekWrapped,
            versions::Column::Checksum,
        ])
        .filter(versions::Column::SecretId.eq(secret_id))
        .filter(versions::Column::Version.eq(version))
        .into_tuple()
        .one(&db)
        .await?;
    let (ciphertext, dek_wrapped, checksum) =
        target.ok_or_else(|| PassError::not_found("secret", &format!("{secret_id}@v{version}")))?;
    let next = int4(secret.version + 1)?;
    append_version(
        &db,
        secret_id,
        &secret.project_id,
        next,
        "restored",
        &ciphertext,
        &dek_wrapped,
        &checksum,
        actor_id,
    )
    .await?;
    let row = secrets::Entity::update(secrets::ActiveModel {
        id: Unchanged(secret_id.to_owned()),
        ciphertext: Set(ciphertext),
        dek_wrapped: Set(dek_wrapped),
        checksum: Set(checksum),
        version: Set(next),
        updated_by: Set(Some(actor_id.to_owned())),
        updated_at: Set(now()),
        deleted_at: Set(None),
        ..Default::default()
    })
    .exec(&db)
    .await?;
    Ok(Secret::from_row(row.into()))
}

#[allow(clippy::too_many_arguments)]
async fn append_version(
    db: &DatabaseConnection,
    secret_id: &str,
    project_id: &str,
    version: i32,
    action: &str,
    ciphertext: &str,
    dek_wrapped: &str,
    checksum: &str,
    created_by: &str,
) -> PassResult<()> {
    versions::Entity::insert(versions::ActiveModel {
        id: Set(generate_id("wpv")),
        secret_id: Set(secret_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        version: Set(version),
        action: Set(action.to_owned()),
        ciphertext: Set(ciphertext.to_owned()),
        dek_wrapped: Set(dek_wrapped.to_owned()),
        checksum: Set(checksum.to_owned()),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;
    Ok(())
}

/// `listSecretKeys`: each environment's keys, by key, without decrypting.
pub(crate) async fn list_secret_keys(
    db: &PgPool,
    environment_ids: &[String],
) -> PassResult<Vec<(String, Vec<String>)>> {
    if environment_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String)> = secrets::Entity::find()
        .select_only()
        .columns([S::EnvironmentId, S::Key])
        .filter(S::EnvironmentId.is_in(environment_ids.iter().map(String::as_str)))
        .filter(S::DeletedAt.is_null())
        .order_by_asc(S::Key)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut by_environment: Vec<(String, Vec<String>)> = Vec::new();
    for (environment, key) in rows {
        match by_environment.iter_mut().find(|(id, _)| *id == environment) {
            Some((_, keys)) => keys.push(key),
            None => by_environment.push((environment, vec![key])),
        }
    }
    Ok(by_environment)
}

/// The keys of one environment from [`list_secret_keys`].
pub(crate) fn keys_of<'a>(keys: &'a [(String, Vec<String>)], environment_id: &str) -> &'a [String] {
    keys.iter()
        .find(|(id, _)| id == environment_id)
        .map_or(&[], |(_, keys)| keys.as_slice())
}

/// What [`backfill_checksums`] rewrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Backfilled {
    pub secrets: u64,
    pub versions: u64,
    pub failed: u64,
}

/// `backfillChecksums`: every pre-HMAC checksum of one project (current rows,
/// soft-deleted included, and history rows) rewritten as a keyed one.
/// Idempotent; a row that will not open is counted, not fatal. Not wired to
/// a route, as in TypeScript: an operator task with the project's KEK.
pub async fn backfill_checksums(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
) -> Result<Backfilled, DbErr> {
    let db = orm(db);
    let mut result = Backfilled::default();
    let rows: Vec<(String, String, String, String, String, String)> = secrets::Entity::find()
        .select_only()
        .columns([
            S::Id,
            S::EnvironmentId,
            S::Key,
            S::Ciphertext,
            S::DekWrapped,
            S::Checksum,
        ])
        .filter(S::ProjectId.eq(project_id))
        .into_tuple()
        .all(&db)
        .await?;
    for (id, environment, key, ciphertext, dek_wrapped, checksum) in &rows {
        if !is_legacy_checksum(checksum) {
            continue;
        }
        let location = SecretLocation::new(project_id, environment, key);
        match open_secret(kek, &location, ciphertext, dek_wrapped)
            .and_then(|value| checksum_for(kek, &location, &value))
        {
            Ok(keyed) => {
                set_checksum(&db, id, &keyed).await?;
                result.secrets += 1;
            }
            Err(_) => result.failed += 1,
        }
    }

    // A version row sits at its secret's location (a restore reuses the
    // ciphertext as it is), so the same location opens and re-keys it.
    let history: Vec<(String, String, String, String)> = versions::Entity::find()
        .select_only()
        .columns([
            versions::Column::Id,
            versions::Column::SecretId,
            versions::Column::Ciphertext,
            versions::Column::DekWrapped,
        ])
        .filter(versions::Column::ProjectId.eq(project_id))
        .filter(versions::Column::Checksum.not_like("h1:%"))
        .into_tuple()
        .all(&db)
        .await?;
    for (id, secret_id, ciphertext, dek_wrapped) in &history {
        let location = rows
            .iter()
            .find(|row| row.0 == *secret_id)
            .map(|row| SecretLocation::new(project_id, &row.1, &row.2));
        let keyed = location.and_then(|location| {
            open_secret(kek, &location, ciphertext, dek_wrapped)
                .and_then(|value| checksum_for(kek, &location, &value))
                .ok()
        });
        match keyed {
            Some(keyed) => {
                versions::Entity::update_many()
                    .col_expr(versions::Column::Checksum, Expr::value(keyed))
                    .filter(versions::Column::Id.eq(id))
                    .exec(&db)
                    .await?;
                result.versions += 1;
            }
            None => result.failed += 1,
        }
    }
    Ok(result)
}
