//! Provider API tokens (`services/weldpass/credentials.ts`): sealed like a
//! secret value at the credential's own location, write-only through the
//! API; only a push and a verification read one back.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Select, Set,
};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldpass_provider_credentials as credentials, weldpass_sync_targets};

use crate::envelope::{Key, credential_location, open_secret, seal_secret};
use crate::providers::{self, VerifyResult};
use crate::transport::HttpTransport;
use crate::{PassError, PassResult, millis, now, row_json};

use credentials::Column as C;

/// A credential's client-safe columns: never its sealed token.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRow {
    id: String,
    project_id: String,
    provider: String,
    name: String,
    metadata: Value,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    last_verified_at: Option<OffsetDateTime>,
    last_verify_error: Option<String>,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl CredentialRow {
    fn select() -> Select<credentials::Entity> {
        credentials::Entity::find().select_only().columns([
            C::Id,
            C::ProjectId,
            C::Provider,
            C::Name,
            C::Metadata,
            C::LastVerifiedAt,
            C::LastVerifyError,
            C::CreatedBy,
            C::CreatedAt,
            C::UpdatedAt,
        ])
    }
}

impl From<credentials::Model> for CredentialRow {
    fn from(row: credentials::Model) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            provider: row.provider,
            name: row.name,
            metadata: row.metadata,
            last_verified_at: row.last_verified_at,
            last_verify_error: row.last_verify_error,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `CredentialSummary`.
#[derive(Debug, Clone)]
pub(crate) struct Credential {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    pub(crate) json: Value,
    /// `lastVerifiedAt` as the worker holds it, a `Date`.
    last_verified_at: Option<OffsetDateTime>,
}

impl Credential {
    fn from_row(row: CredentialRow) -> Self {
        Self {
            json: row_json(&row),
            last_verified_at: row.last_verified_at.map(millis),
            id: row.id,
            provider: row.provider,
            name: row.name,
        }
    }
}

/// `listCredentials`: by name.
pub(crate) async fn list_credentials(db: &PgPool, project_id: &str) -> PassResult<Vec<Credential>> {
    let rows = CredentialRow::select()
        .filter(C::ProjectId.eq(project_id))
        .filter(C::DeletedAt.is_null())
        .order_by_asc(C::Name)
        .into_model::<CredentialRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Credential::from_row).collect())
}

/// `requireCredential`.
pub(crate) async fn require_credential(
    db: &PgPool,
    project_id: &str,
    credential_id: &str,
) -> PassResult<Credential> {
    let row = CredentialRow::select()
        .filter(C::Id.eq(credential_id))
        .filter(C::ProjectId.eq(project_id))
        .filter(C::DeletedAt.is_null())
        .into_model::<CredentialRow>()
        .one(&orm(db))
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
    let row = credentials::Entity::insert(credentials::ActiveModel {
        id: Set(id),
        project_id: Set(project_id.to_owned()),
        provider: Set(provider.to_owned()),
        name: Set(name.to_owned()),
        ciphertext: Set(sealed.ciphertext),
        dek_wrapped: Set(sealed.dek_wrapped),
        metadata: Set(metadata
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()))),
        created_by: Set(Some(actor_id.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(Credential::from_row(row.into()))
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
    let mut patch = credentials::ActiveModel {
        id: Unchanged(credential_id.to_owned()),
        updated_at: Set(now()),
        ..Default::default()
    };
    if let Some(name) = name {
        patch.name = Set(name.to_owned());
    }
    if let Some(metadata) = metadata {
        patch.metadata = Set(metadata.clone());
    }
    if let Some(sealed) = sealed {
        patch.ciphertext = Set(sealed.ciphertext);
        patch.dek_wrapped = Set(sealed.dek_wrapped);
        patch.last_verified_at = Set(None);
        patch.last_verify_error = Set(None);
    }
    let row = credentials::Entity::update(patch).exec(&orm(db)).await?;
    Ok(Credential::from_row(row.into()))
}

/// `deleteCredential`: its sync targets are retired with it.
pub(crate) async fn delete_credential(
    db: &PgPool,
    project_id: &str,
    credential_id: &str,
) -> PassResult<i64> {
    require_credential(db, project_id, credential_id).await?;
    let now = now();
    let db = orm(db);
    let detached = weldpass_sync_targets::Entity::update_many()
        .col_expr(weldpass_sync_targets::Column::DeletedAt, Expr::value(now))
        .col_expr(weldpass_sync_targets::Column::UpdatedAt, Expr::value(now))
        .filter(weldpass_sync_targets::Column::CredentialId.eq(credential_id))
        .filter(weldpass_sync_targets::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    credentials::Entity::update_many()
        .col_expr(C::DeletedAt, Expr::value(now))
        .col_expr(C::UpdatedAt, Expr::value(now))
        .filter(C::Id.eq(credential_id))
        .exec(&db)
        .await?;
    Ok(i64::try_from(detached.rows_affected).unwrap_or(i64::MAX))
}

/// `readCredentialToken`.
pub(crate) async fn read_credential_token(
    db: &PgPool,
    kek: &Key,
    project_id: &str,
    credential_id: &str,
) -> PassResult<String> {
    let row: Option<(String, String)> = credentials::Entity::find()
        .select_only()
        .columns([C::Ciphertext, C::DekWrapped])
        .filter(C::Id.eq(credential_id))
        .filter(C::ProjectId.eq(project_id))
        .filter(C::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
            credential.last_verified_at,
            // `result.message ?? 'Verification failed'`: a failure always
            // carries a message.
            Some(message.clone()),
        ),
    };
    credentials::Entity::update_many()
        .col_expr(C::LastVerifiedAt, Expr::value(verified_at))
        .col_expr(C::LastVerifyError, Expr::value(error))
        .col_expr(C::UpdatedAt, Expr::value(now()))
        .filter(C::Id.eq(credential_id))
        .exec(&orm(db))
        .await?;
    Ok(result)
}
