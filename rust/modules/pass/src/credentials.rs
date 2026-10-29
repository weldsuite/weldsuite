//! Provider API tokens (`services/weldpass/credentials.ts`): sealed like a
//! secret value at the credential's own location, write-only through the
//! API; only a push and a verification read one back.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::envelope::{Key, credential_location, open_secret, seal_secret};
use crate::providers::{self, VerifyResult};
use crate::transport::HttpTransport;
use crate::{PassError, PassResult, dated, now};

macro_rules! credential_json {
    () => {
        "jsonb_build_object('id', c.id, 'projectId', c.project_id, 'provider', c.provider, \
         'name', c.name, 'metadata', c.metadata, 'lastVerifiedAt', c.last_verified_at, \
         'lastVerifyError', c.last_verify_error, 'createdBy', c.created_by, \
         'createdAt', c.created_at, 'updatedAt', c.updated_at)"
    };
}

const TIMES: [&str; 3] = ["lastVerifiedAt", "createdAt", "updatedAt"];

/// `CredentialSummary`.
#[derive(Debug, Clone)]
pub(crate) struct Credential {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    pub(crate) json: Value,
}

impl Credential {
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            provider: text("provider"),
            name: text("name"),
            json: row,
        }
    }
}

/// `listCredentials`: by name.
pub(crate) async fn list_credentials(db: &PgPool, project_id: &str) -> PassResult<Vec<Credential>> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        credential_json!(),
        " from weldpass_provider_credentials c where c.project_id = $1 and c.deleted_at is null \
         order by c.name asc"
    ))
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Credential::from_row).collect())
}

/// `requireCredential`.
pub(crate) async fn require_credential(
    db: &PgPool,
    project_id: &str,
    credential_id: &str,
) -> PassResult<Credential> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        credential_json!(),
        " from weldpass_provider_credentials c where c.id = $1 and c.project_id = $2 \
         and c.deleted_at is null limit 1"
    ))
    .bind(credential_id)
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    row.map(Credential::from_row)
        .ok_or_else(|| PassError::not_found("credential", credential_id))
}

/// `createCredential`.
#[allow(clippy::too_many_arguments)] // the worker's input object, field by field
pub(crate) async fn create_credential(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    provider: &str,
    name: &str,
    token: &str,
    metadata: Option<&Value>,
    actor_id: &str,
) -> PassResult<Credential> {
    let id = generate_id("wpc");
    let sealed = seal_secret(kek, &credential_location(project_id, &id), token)?;
    let empty = Value::Object(serde_json::Map::new());
    let row: Value = sqlx::query_scalar(concat!(
        "with c as (insert into weldpass_provider_credentials \
         (id, project_id, provider, name, ciphertext, dek_wrapped, metadata, created_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *) select ",
        credential_json!(),
        " from c"
    ))
    .bind(&id)
    .bind(project_id)
    .bind(provider)
    .bind(name)
    .bind(&sealed.ciphertext)
    .bind(&sealed.dek_wrapped)
    .bind(metadata.unwrap_or(&empty))
    .bind(actor_id)
    .fetch_one(db)
    .await?;
    Ok(Credential::from_row(row))
}

/// `updateCredential`: a new token resets the verification.
pub(crate) async fn update_credential(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    credential_id: &str,
    name: Option<&str>,
    token: Option<&str>,
    metadata: Option<&Value>,
) -> PassResult<Credential> {
    require_credential(db, project_id, credential_id).await?;
    let sealed = token
        .map(|token| seal_secret(kek, &credential_location(project_id, credential_id), token))
        .transpose()?;
    let row: Value = sqlx::query_scalar(concat!(
        "with c as (update weldpass_provider_credentials set \
         updated_at = $2::timestamptz, name = coalesce($3, name), \
         metadata = case when $4 then $5 else metadata end, \
         ciphertext = coalesce($6, ciphertext), dek_wrapped = coalesce($7, dek_wrapped), \
         last_verified_at = case when $8 then null else last_verified_at end, \
         last_verify_error = case when $8 then null else last_verify_error end \
         where id = $1 returning *) select ",
        credential_json!(),
        " from c"
    ))
    .bind(credential_id)
    .bind(now())
    .bind(name)
    .bind(metadata.is_some())
    .bind(metadata)
    .bind(sealed.as_ref().map(|s| s.ciphertext.as_str()))
    .bind(sealed.as_ref().map(|s| s.dek_wrapped.as_str()))
    .bind(sealed.is_some())
    .fetch_one(db)
    .await?;
    Ok(Credential::from_row(row))
}

/// `deleteCredential`: its sync targets are retired with it.
pub(crate) async fn delete_credential(
    db: &PgPool,
    project_id: &str,
    credential_id: &str,
) -> PassResult<i64> {
    require_credential(db, project_id, credential_id).await?;
    let now = now();
    let detached: Vec<String> = sqlx::query_scalar(
        "update weldpass_sync_targets set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where credential_id = $1 and deleted_at is null returning id",
    )
    .bind(credential_id)
    .bind(&now)
    .fetch_all(db)
    .await?;
    sqlx::query(
        "update weldpass_provider_credentials set deleted_at = $2::timestamptz, \
         updated_at = $2::timestamptz where id = $1",
    )
    .bind(credential_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(i64::try_from(detached.len()).unwrap_or(i64::MAX))
}

/// `readCredentialToken`.
pub(crate) async fn read_credential_token(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    credential_id: &str,
) -> PassResult<String> {
    let row: Option<(String, String)> = sqlx::query_as(
        "select ciphertext, dek_wrapped from weldpass_provider_credentials \
         where id = $1 and project_id = $2 and deleted_at is null limit 1",
    )
    .bind(credential_id)
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let (ciphertext, dek_wrapped) =
        row.ok_or_else(|| PassError::not_found("credential", credential_id))?;
    Ok(open_secret(
        kek,
        &credential_location(project_id, credential_id),
        &ciphertext,
        &dek_wrapped,
    )?)
}

/// `verifyCredential`: ask the provider, and record the answer.
pub(crate) async fn verify_credential(
    db: &PgPool,
    kek: &Key,
    http: &dyn HttpTransport,
    project_id: &str,
    credential_id: &str,
    config: &Value,
) -> PassResult<VerifyResult> {
    let credential = require_credential(db, project_id, credential_id).await?;
    let token = read_credential_token(db, kek, project_id, credential_id).await?;
    let result = providers::verify(http, &credential.provider, &token, config)
        .await
        .map_err(|error| PassError::Provider(error.0))?;
    let (verified_at, error) = match &result {
        VerifyResult::Ok(_) => (Some(now()), None),
        VerifyResult::Failed(message) => (
            credential.json["lastVerifiedAt"]
                .as_str()
                .map(str::to_owned),
            // `result.message ?? 'Verification failed'`: a failure always
            // carries a message.
            Some(message.clone()),
        ),
    };
    sqlx::query(
        "update weldpass_provider_credentials set last_verified_at = $2::timestamptz, \
         last_verify_error = $3, updated_at = $4::timestamptz where id = $1",
    )
    .bind(credential_id)
    .bind(verified_at)
    .bind(error)
    .bind(now())
    .execute(db)
    .await?;
    Ok(result)
}
