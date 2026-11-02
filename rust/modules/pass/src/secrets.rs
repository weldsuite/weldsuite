//! Secret reads and writes (`services/weldpass/secrets.ts`). Listing never
//! decrypts; only a reveal and an environment read open a value. Every write
//! appends to `weldpass_secret_versions` before the current row changes.
//! Checksums written before they were keyed (a bare SHA-256) are upgraded
//! whenever the plaintext is in hand.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::dotenv::is_valid_secret_key;
use crate::envelope::{
    Key, SecretLocation, checksum_for, checksum_matches, is_legacy_checksum, open_secret,
    seal_secret,
};
use crate::js::JsRecord;
use crate::{PassError, PassResult, dated, now};

macro_rules! secret_json {
    () => {
        "jsonb_build_object('id', s.id, 'projectId', s.project_id, 'environmentId', s.environment_id, \
         'key', s.key, 'note', s.note, 'version', s.version, 'valueLength', s.value_length, \
         'valueHint', s.value_hint, 'checksum', s.checksum, 'createdBy', s.created_by, \
         'updatedBy', s.updated_by, 'createdAt', s.created_at, 'updatedAt', s.updated_at)"
    };
}

const TIMES: [&str; 2] = ["createdAt", "updatedAt"];

/// `SecretSummary`: what a client sees without `secrets:reveal`.
#[derive(Debug, Clone)]
pub(crate) struct Secret {
    pub(crate) id: String,
    pub(crate) key: String,
    pub(crate) project_id: String,
    pub(crate) version: i64,
    pub(crate) checksum: String,
    pub(crate) json: Value,
}

impl Secret {
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            key: text("key"),
            project_id: text("projectId"),
            version: row["version"].as_i64().unwrap_or_default(),
            checksum: text("checksum"),
            json: row,
        }
    }

    fn location(&self, environment_id: &str) -> SecretLocation {
        SecretLocation::new(&self.project_id, environment_id, &self.key)
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
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        secret_json!(),
        " from weldpass_secrets s where s.environment_id = $1 and s.deleted_at is null order by s.key asc"
    ))
    .bind(environment_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Secret::from_row).collect())
}

/// `requireSecret`.
pub(crate) async fn require_secret(
    db: &PgPool,
    environment_id: &str,
    secret_id: &str,
) -> PassResult<Secret> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        secret_json!(),
        " from weldpass_secrets s where s.id = $1 and s.environment_id = $2 and s.deleted_at is null limit 1"
    ))
    .bind(secret_id)
    .bind(environment_id)
    .fetch_optional(db)
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
    let row: Option<(Value, String, String)> = sqlx::query_as(concat!(
        "select ",
        secret_json!(),
        ", s.ciphertext, s.dek_wrapped from weldpass_secrets s \
         where s.id = $1 and s.environment_id = $2 and s.deleted_at is null limit 1"
    ))
    .bind(secret_id)
    .bind(environment_id)
    .fetch_optional(db)
    .await?;
    let (row, ciphertext, dek_wrapped) =
        row.ok_or_else(|| PassError::not_found("secret", secret_id))?;
    let mut secret = Secret::from_row(row);
    let location = secret.location(environment_id_of(&secret.json, environment_id));
    let value = open_secret(kek, &location, &ciphertext, &dek_wrapped)?;

    // Opportunistic: a failed upgrade must not stop the reveal.
    if is_legacy_checksum(&secret.checksum)
        && let Ok(checksum) = checksum_for(kek, &location, &value)
        && sqlx::query("update weldpass_secrets set checksum = $2 where id = $1")
            .bind(&secret.id)
            .bind(&checksum)
            .execute(db)
            .await
            .is_ok()
    {
        secret.json["checksum"] = Value::String(checksum.clone());
        secret.checksum = checksum;
    }
    Ok((secret, value))
}

fn environment_id_of<'a>(json: &'a Value, fallback: &'a str) -> &'a str {
    json["environmentId"].as_str().unwrap_or(fallback)
}

/// `readEnvironmentValues`: every value, by key, for an export or a push.
pub(crate) async fn read_environment_values(
    db: &PgPool,
    kek: &Key,
    environment_id: &str,
) -> PassResult<JsRecord> {
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "select project_id, environment_id, key, ciphertext, dek_wrapped from weldpass_secrets \
         where environment_id = $1 and deleted_at is null order by key asc",
    )
    .bind(environment_id)
    .fetch_all(db)
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
    let existing: Option<(String, i32, String, Option<String>)> = sqlx::query_as(
        "select id, version, checksum, note from weldpass_secrets \
         where environment_id = $1 and key = $2 limit 1",
    )
    .bind(environment_id)
    .bind(key)
    .fetch_optional(db)
    .await?;

    let location = SecretLocation::new(project_id, environment_id, key);
    let sealed = seal_secret(kek, &location, value)?;
    let now = now();

    let Some((existing_id, version, checksum, existing_note)) = existing else {
        let id = generate_id("wps");
        let row: Value = sqlx::query_scalar(concat!(
            "with s as (insert into weldpass_secrets \
             (id, project_id, environment_id, key, ciphertext, dek_wrapped, checksum, value_length, \
              value_hint, note, version, created_by, updated_by) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11) returning *) select ",
            secret_json!(),
            " from s"
        ))
        .bind(&id)
        .bind(project_id)
        .bind(environment_id)
        .bind(key)
        .bind(&sealed.ciphertext)
        .bind(&sealed.dek_wrapped)
        .bind(&sealed.checksum)
        .bind(sealed.value_length)
        .bind(sealed.value_hint.as_deref())
        .bind(note.flatten())
        .bind(actor_id)
        .fetch_one(db)
        .await?;
        append_version(
            db,
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
            secret: Secret::from_row(row),
            created: true,
            changed: true,
        });
    };

    let note_changed = note.is_some_and(|note| note != existing_note.as_deref());
    let same_value = checksum_matches(&checksum, &sealed.checksum, value);
    if same_value && !note_changed {
        if is_legacy_checksum(&checksum) {
            sqlx::query("update weldpass_secrets set checksum = $2 where id = $1")
                .bind(&existing_id)
                .bind(&sealed.checksum)
                .execute(db)
                .await?;
        }
        let secret = require_secret(db, environment_id, &existing_id).await?;
        return Ok(Upserted {
            secret,
            created: false,
            changed: false,
        });
    }

    let next = i64::from(version) + 1;
    // History first: the other order could lose the only copy of a value.
    append_version(
        db,
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
    let row: Value = sqlx::query_scalar(concat!(
        "with s as (update weldpass_secrets set ciphertext = $2, dek_wrapped = $3, checksum = $4, \
         value_length = $5, value_hint = $6, note = $7, version = $8, updated_by = $9, \
         updated_at = $10::timestamptz, deleted_at = null where id = $1 returning *) select ",
        secret_json!(),
        " from s"
    ))
    .bind(&existing_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.dek_wrapped)
    .bind(&sealed.checksum)
    .bind(sealed.value_length)
    .bind(sealed.value_hint.as_deref())
    .bind(note.as_deref())
    .bind(next)
    .bind(actor_id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    Ok(Upserted {
        secret: Secret::from_row(row),
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
    let current: Option<(String, String)> = sqlx::query_as(
        "select ciphertext, dek_wrapped from weldpass_secrets where id = $1 limit 1",
    )
    .bind(secret_id)
    .fetch_optional(db)
    .await?;
    let (ciphertext, dek_wrapped) =
        current.ok_or_else(|| PassError::not_found("secret", secret_id))?;
    let now = now();
    sqlx::query(
        "update weldpass_secrets set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, \
         updated_by = $3 where id = $1",
    )
    .bind(secret_id)
    .bind(&now)
    .bind(actor_id)
    .execute(db)
    .await?;
    append_version(
        db,
        secret_id,
        &secret.project_id,
        secret.version + 1,
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
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', v.id, 'version', v.version, 'action', v.action, \
         'checksum', v.checksum, 'createdBy', v.created_by, 'createdAt', v.created_at) \
         from weldpass_secret_versions v where v.secret_id = $1 order by v.version desc limit 50",
    )
    .bind(secret_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| dated(row, &["createdAt"]))
        .collect())
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
    let target: Option<(String, String, String)> = sqlx::query_as(
        "select ciphertext, dek_wrapped, checksum from weldpass_secret_versions \
         where secret_id = $1 and version = $2 limit 1",
    )
    .bind(secret_id)
    .bind(version)
    .fetch_optional(db)
    .await?;
    let (ciphertext, dek_wrapped, checksum) =
        target.ok_or_else(|| PassError::not_found("secret", &format!("{secret_id}@v{version}")))?;
    let next = secret.version + 1;
    append_version(
        db,
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
    let row: Value = sqlx::query_scalar(concat!(
        "with s as (update weldpass_secrets set ciphertext = $2, dek_wrapped = $3, checksum = $4, \
         version = $5, updated_by = $6, updated_at = $7::timestamptz, deleted_at = null \
         where id = $1 returning *) select ",
        secret_json!(),
        " from s"
    ))
    .bind(secret_id)
    .bind(&ciphertext)
    .bind(&dek_wrapped)
    .bind(&checksum)
    .bind(next)
    .bind(actor_id)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Secret::from_row(row))
}

#[allow(clippy::too_many_arguments)]
async fn append_version(
    db: &PgPool,
    secret_id: &str,
    project_id: &str,
    version: i64,
    action: &str,
    ciphertext: &str,
    dek_wrapped: &str,
    checksum: &str,
    created_by: &str,
) -> PassResult<()> {
    sqlx::query(
        "insert into weldpass_secret_versions \
         (id, secret_id, project_id, version, action, ciphertext, dek_wrapped, checksum, created_by) \
         values ($1, $2, $3, $4::integer, $5, $6, $7, $8, $9)",
    )
    .bind(generate_id("wpv"))
    .bind(secret_id)
    .bind(project_id)
    .bind(version)
    .bind(action)
    .bind(ciphertext)
    .bind(dek_wrapped)
    .bind(checksum)
    .bind(created_by)
    .execute(db)
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
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select environment_id, key from weldpass_secrets \
         where environment_id = any($1) and deleted_at is null order by key asc",
    )
    .bind(environment_ids)
    .fetch_all(db)
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
) -> Result<Backfilled, sqlx::Error> {
    let mut result = Backfilled::default();
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "select id, environment_id, key, ciphertext, dek_wrapped, checksum from weldpass_secrets \
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
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
                sqlx::query("update weldpass_secrets set checksum = $2 where id = $1")
                    .bind(id)
                    .bind(&keyed)
                    .execute(db)
                    .await?;
                result.secrets += 1;
            }
            Err(_) => result.failed += 1,
        }
    }

    // A version row sits at its secret's location (a restore reuses the
    // ciphertext as it is), so the same location opens and re-keys it.
    let versions: Vec<(String, String, String, String)> = sqlx::query_as(
        "select id, secret_id, ciphertext, dek_wrapped from weldpass_secret_versions \
         where project_id = $1 and checksum not like 'h1:%'",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    for (id, secret_id, ciphertext, dek_wrapped) in &versions {
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
                sqlx::query("update weldpass_secret_versions set checksum = $2 where id = $1")
                    .bind(id)
                    .bind(&keyed)
                    .execute(db)
                    .await?;
                result.versions += 1;
            }
            None => result.failed += 1,
        }
    }
    Ok(result)
}
