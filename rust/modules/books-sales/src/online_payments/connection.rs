//! The legal entity's Mollie connection (`accounting_payment_connections`, at
//! most one live row per entity) and the client built on its credentials.
//!
//! Tokens and API keys are sealed with the keyring (`*_encrypted`, DATA-003)
//! and never leave this module as anything but a ready client. An OAuth
//! access token lasts an hour: [`client`] refreshes it when it is about to
//! expire and [`call`] once more when Mollie answers 401; a refresh Mollie
//! refuses marks the connection `needs_reauth`.

use std::future::Future;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use time::Duration;
use weldsuite_db::{decrypt_field, encrypt_field, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_mollie::connect::Tokens;
use weldsuite_mollie::{Mollie, MollieError};
use weldsuite_schema::tenant::accounting_payment_connections as connections;

use super::{Ctx, PROVIDER, PayError};

pub(crate) type Row = connections::Model;

/// The scope that lets a connection read settlements.
pub(crate) const SETTLEMENTS_SCOPE: &str = "settlements.read";

/// The entity's live connection, whatever its state.
pub(crate) async fn live(
    db: &sea_orm::DatabaseConnection,
    entity_id: &str,
) -> Result<Option<Row>, sea_orm::DbErr> {
    connections::Entity::find()
        .filter(connections::Column::EntityId.eq(entity_id))
        .filter(connections::Column::Provider.eq(PROVIDER))
        .filter(connections::Column::DeletedAt.is_null())
        .one(db)
        .await
}

/// The live connection `id`.
pub(crate) async fn by_id(
    db: &sea_orm::DatabaseConnection,
    id: &str,
) -> Result<Option<Row>, sea_orm::DbErr> {
    connections::Entity::find_by_id(id.to_owned())
        .filter(connections::Column::DeletedAt.is_null())
        .one(db)
        .await
}

/// The entity's connection, when it can take payments.
pub(crate) async fn connected(
    db: &sea_orm::DatabaseConnection,
    entity_id: &str,
) -> Result<Option<Row>, sea_orm::DbErr> {
    Ok(live(db, entity_id)
        .await?
        .filter(|row| row.status == "connected"))
}

/// Settlements are the organisation's: only a Mollie Connect token with the
/// scope reads them, an API key cannot.
pub(crate) fn settlements_available(row: &Row) -> bool {
    row.auth_method == "oauth"
        && row
            .scope
            .as_deref()
            .is_some_and(|scope| scope.split_whitespace().any(|s| s == SETTLEMENTS_SCOPE))
}

/// The methods the entity offers, as Mollie ids.
pub(crate) fn methods_of(row: &Row) -> Vec<String> {
    row.methods
        .as_ref()
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The connection as the API shows it: never a token, key or secret.
pub(crate) fn view(row: &Row) -> Value {
    json!({
        "id": row.id,
        "provider": PROVIDER,
        "status": row.status,
        "authMethod": row.auth_method,
        "profileId": row.profile_id,
        "profileName": row.profile_name,
        "organizationName": row.organization_name,
        "testmode": row.testmode,
        "methods": methods_of(row),
        "connectedAt": row.connected_at.map(|at| weldsuite_events::iso_timestamp(at.assume_utc())),
        "settlementsAvailable": settlements_available(row),
        "settlementsSyncedAt": row.settlements_synced_at.map(|at| weldsuite_events::iso_timestamp(at.assume_utc())),
        "bankAccountId": row.bank_account_id,
        "lastError": row.last_error,
    })
}

/// The event data of a connection: the same, which holds no secret.
pub(crate) fn event_data(row: &Row) -> Value {
    json!({
        "id": row.id,
        "entityId": row.entity_id,
        "provider": PROVIDER,
        "status": row.status,
        "authMethod": row.auth_method,
        "profileId": row.profile_id,
        "organizationName": row.organization_name,
        "testmode": row.testmode,
        "methods": methods_of(row),
    })
}

/// A connection to store, replacing the entity's one.
pub(crate) struct NewConnection<'a> {
    pub entity_id: &'a str,
    pub auth_method: &'a str,
    pub tokens: Option<&'a Tokens>,
    pub api_key: Option<&'a str>,
    pub testmode: bool,
    pub profile_id: Option<&'a str>,
    pub profile_name: Option<&'a str>,
    pub organization_id: Option<&'a str>,
    pub organization_name: Option<&'a str>,
    pub methods: Option<Vec<String>>,
    pub connected_by: Option<&'a str>,
}

fn seal(ctx: &Ctx, value: &str) -> Result<String, PayError> {
    encrypt_field(value, &ctx.books.keyring).map_err(|_| {
        PayError::Unavailable("The credentials cannot be stored securely: no encryption key")
    })
}

fn open(ctx: &Ctx, value: Option<&str>) -> Result<String, PayError> {
    let value = value.ok_or(PayError::NotConnected)?;
    decrypt_field(value, &ctx.books.keyring)
        .map_err(|_| PayError::Unavailable("The stored credentials cannot be opened"))
}

fn expiry(tokens: &Tokens) -> time::PrimitiveDateTime {
    utc_now() + Duration::seconds(tokens.expires_in.clamp(60, 86_400))
}

/// Stores the connection, a reconnect replacing the entity's live one (it
/// keeps its id, so references already given to Mollie keep working).
pub(crate) async fn save(ctx: &Ctx, new: &NewConnection<'_>) -> Result<Row, PayError> {
    let db = orm(&ctx.db);
    let access = new.tokens.map(|t| seal(ctx, &t.access_token)).transpose()?;
    let refresh = new
        .tokens
        .and_then(|t| t.refresh_token.as_deref())
        .map(|t| seal(ctx, t))
        .transpose()?;
    let api_key = new.api_key.map(|k| seal(ctx, k)).transpose()?;
    let stamp = utc_now();
    let methods = new.methods.as_ref().map(|list| json!(list));
    let scope = new.tokens.and_then(|t| t.scope.clone());
    let expires = new.tokens.map(expiry);
    if let Some(existing) = live(&db, new.entity_id).await? {
        connections::Entity::update_many()
            .col_expr(
                connections::Column::AuthMethod,
                Expr::value(new.auth_method),
            )
            .col_expr(connections::Column::Status, Expr::value("connected"))
            .col_expr(
                connections::Column::AccessTokenEncrypted,
                Expr::value(access),
            )
            .col_expr(
                connections::Column::RefreshTokenEncrypted,
                Expr::value(refresh),
            )
            .col_expr(connections::Column::ApiKeyEncrypted, Expr::value(api_key))
            .col_expr(connections::Column::TokenExpiresAt, Expr::value(expires))
            .col_expr(connections::Column::Scope, Expr::value(scope))
            .col_expr(connections::Column::ProfileId, Expr::value(new.profile_id))
            .col_expr(
                connections::Column::ProfileName,
                Expr::value(new.profile_name),
            )
            .col_expr(
                connections::Column::OrganizationId,
                Expr::value(new.organization_id),
            )
            .col_expr(
                connections::Column::OrganizationName,
                Expr::value(new.organization_name),
            )
            .col_expr(connections::Column::Testmode, Expr::value(new.testmode))
            .col_expr(connections::Column::Methods, Expr::value(methods))
            .col_expr(
                connections::Column::ConnectedBy,
                Expr::value(new.connected_by),
            )
            .col_expr(connections::Column::ConnectedAt, Expr::value(stamp))
            .col_expr(
                connections::Column::DisconnectedAt,
                Expr::value(Option::<time::PrimitiveDateTime>::None),
            )
            .col_expr(
                connections::Column::LastError,
                Expr::value(Option::<String>::None),
            )
            .col_expr(connections::Column::UpdatedAt, Expr::value(stamp))
            .filter(connections::Column::Id.eq(existing.id.as_str()))
            .exec(&db)
            .await?;
        return by_id(&db, &existing.id)
            .await?
            .ok_or(PayError::NotConnected);
    }
    let id = generate_id("apc");
    connections::Entity::insert(connections::ActiveModel {
        id: ActiveValue::Set(id.clone()),
        entity_id: ActiveValue::Set(new.entity_id.to_owned()),
        provider: ActiveValue::Set(PROVIDER.to_owned()),
        auth_method: ActiveValue::Set(new.auth_method.to_owned()),
        status: ActiveValue::Set("connected".to_owned()),
        access_token_encrypted: ActiveValue::Set(access),
        refresh_token_encrypted: ActiveValue::Set(refresh),
        api_key_encrypted: ActiveValue::Set(api_key),
        token_expires_at: ActiveValue::Set(expires),
        scope: ActiveValue::Set(scope),
        profile_id: ActiveValue::Set(new.profile_id.map(str::to_owned)),
        profile_name: ActiveValue::Set(new.profile_name.map(str::to_owned)),
        organization_id: ActiveValue::Set(new.organization_id.map(str::to_owned)),
        organization_name: ActiveValue::Set(new.organization_name.map(str::to_owned)),
        testmode: ActiveValue::Set(new.testmode),
        methods: ActiveValue::Set(methods),
        connected_by: ActiveValue::Set(new.connected_by.map(str::to_owned)),
        connected_at: ActiveValue::Set(Some(stamp)),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    by_id(&db, &id).await?.ok_or(PayError::NotConnected)
}

/// Remembers the entity's money account on the connection.
pub(crate) async fn set_bank_account(
    db: &sea_orm::DatabaseConnection,
    id: &str,
    bank_account_id: &str,
) -> Result<(), sea_orm::DbErr> {
    connections::Entity::update_many()
        .col_expr(
            connections::Column::BankAccountId,
            Expr::value(bank_account_id),
        )
        .col_expr(connections::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(connections::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

/// The enabled methods of the connection.
pub(crate) async fn set_methods(
    db: &sea_orm::DatabaseConnection,
    id: &str,
    methods: &[String],
) -> Result<(), sea_orm::DbErr> {
    connections::Entity::update_many()
        .col_expr(connections::Column::Methods, Expr::value(json!(methods)))
        .col_expr(connections::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(connections::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

/// When the settlements were last read.
pub(crate) async fn mark_synced(
    db: &sea_orm::DatabaseConnection,
    id: &str,
) -> Result<(), sea_orm::DbErr> {
    connections::Entity::update_many()
        .col_expr(
            connections::Column::SettlementsSyncedAt,
            Expr::value(utc_now()),
        )
        .filter(connections::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

/// The connection cannot be used until the merchant connects again.
pub(crate) async fn mark_needs_reauth(
    db: &sea_orm::DatabaseConnection,
    id: &str,
    why: &str,
) -> Result<(), sea_orm::DbErr> {
    connections::Entity::update_many()
        .col_expr(connections::Column::Status, Expr::value("needs_reauth"))
        .col_expr(
            connections::Column::LastError,
            Expr::value(why.chars().take(500).collect::<String>()),
        )
        .col_expr(connections::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(connections::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

/// Disconnects: the credentials go, the row is soft-deleted (a reconnect is a
/// new row), and Mollie forgets an OAuth grant when it can (best effort).
pub(crate) async fn disconnect(ctx: &Ctx, row: &Row) -> Result<(), PayError> {
    if row.auth_method == "oauth"
        && let Some(app) = &ctx.settings.connect
    {
        for (token, hint) in [
            (row.refresh_token_encrypted.as_deref(), "refresh_token"),
            (row.access_token_encrypted.as_deref(), "access_token"),
        ] {
            let Some(plain) = token.and_then(|t| decrypt_field(t, &ctx.books.keyring).ok()) else {
                continue;
            };
            if let Err(error) = app.revoke(&ctx.http, &plain, hint).await {
                tracing::warn!(%error, "[books/mollie] Mollie did not revoke the {hint}");
            }
        }
    }
    let stamp = utc_now();
    connections::Entity::update_many()
        .col_expr(connections::Column::Status, Expr::value("disconnected"))
        .col_expr(
            connections::Column::AccessTokenEncrypted,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            connections::Column::RefreshTokenEncrypted,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            connections::Column::ApiKeyEncrypted,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            connections::Column::TokenExpiresAt,
            Expr::value(Option::<time::PrimitiveDateTime>::None),
        )
        .col_expr(
            connections::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(connections::Column::DisconnectedAt, Expr::value(stamp))
        .col_expr(connections::Column::DeletedAt, Expr::value(stamp))
        .col_expr(connections::Column::UpdatedAt, Expr::value(stamp))
        .filter(connections::Column::Id.eq(row.id.as_str()))
        .exec(&orm(&ctx.db))
        .await?;
    Ok(())
}

fn client_on(ctx: &Ctx, row: &Row, access: &str) -> Mollie {
    let mollie = Mollie::new(&ctx.settings.api_url, access);
    if row.auth_method == "oauth" {
        let mollie = mollie.with_testmode(row.testmode);
        match &row.profile_id {
            Some(profile) => mollie.with_profile(profile),
            None => mollie,
        }
    } else {
        mollie
    }
}

/// Gets a new access token with the stored refresh token and keeps it.
async fn refresh(ctx: &Ctx, row: &Row) -> Result<String, PayError> {
    let Some(app) = &ctx.settings.connect else {
        return Err(PayError::NotConnected);
    };
    let refresh_token = open(ctx, row.refresh_token_encrypted.as_deref())?;
    match app.refresh(&ctx.http, &refresh_token).await {
        Ok(tokens) => {
            let access = seal(ctx, &tokens.access_token)?;
            let mut update = connections::Entity::update_many()
                .col_expr(
                    connections::Column::AccessTokenEncrypted,
                    Expr::value(access),
                )
                .col_expr(
                    connections::Column::TokenExpiresAt,
                    Expr::value(expiry(&tokens)),
                )
                .col_expr(connections::Column::Status, Expr::value("connected"))
                .col_expr(
                    connections::Column::LastError,
                    Expr::value(Option::<String>::None),
                )
                .col_expr(connections::Column::UpdatedAt, Expr::value(utc_now()));
            if let Some(new_refresh) = tokens.refresh_token.as_deref() {
                update = update.col_expr(
                    connections::Column::RefreshTokenEncrypted,
                    Expr::value(seal(ctx, new_refresh)?),
                );
            }
            if let Some(scope) = tokens.scope.as_deref() {
                update = update.col_expr(connections::Column::Scope, Expr::value(scope));
            }
            update
                .filter(connections::Column::Id.eq(row.id.as_str()))
                .exec(&orm(&ctx.db))
                .await?;
            Ok(tokens.access_token)
        }
        Err(error) if error.is_refusal() => {
            mark_needs_reauth(&orm(&ctx.db), &row.id, &error.to_string()).await?;
            Err(PayError::NotConnected)
        }
        Err(error) => Err(error.into()),
    }
}

/// A Mollie client on the connection's credentials; an OAuth token about to
/// expire is refreshed first.
pub(crate) async fn client(ctx: &Ctx, row: &Row) -> Result<Mollie, PayError> {
    if row.status != "connected" {
        return Err(PayError::NotConnected);
    }
    let access = if row.auth_method == "oauth" {
        let soon = utc_now() + Duration::seconds(120);
        if row.token_expires_at.is_none_or(|at| at < soon) || row.access_token_encrypted.is_none() {
            refresh(ctx, row).await?
        } else {
            open(ctx, row.access_token_encrypted.as_deref())?
        }
    } else {
        open(ctx, row.api_key_encrypted.as_deref())?
    };
    Ok(client_on(ctx, row, &access))
}

/// Runs a call on the connection's client; on a 401 with an OAuth token, once
/// more on a fresh one. A 401 that survives marks the connection
/// `needs_reauth`.
pub(crate) async fn call<T, F, Fut>(ctx: &Ctx, row: &Row, run: F) -> Result<T, PayError>
where
    F: Fn(Mollie) -> Fut,
    Fut: Future<Output = Result<T, MollieError>>,
{
    let mollie = client(ctx, row).await?;
    match run(mollie).await {
        Err(error) if error.is_unauthorized() => {
            if row.auth_method == "oauth" {
                let access = refresh(ctx, row).await?;
                match run(client_on(ctx, row, &access)).await {
                    Err(again) if again.is_unauthorized() => {
                        mark_needs_reauth(
                            &orm(&ctx.db),
                            &row.id,
                            "Mollie does not accept the credentials",
                        )
                        .await?;
                        Err(PayError::NotConnected)
                    }
                    other => other.map_err(Into::into),
                }
            } else {
                mark_needs_reauth(&orm(&ctx.db), &row.id, "Mollie does not accept the API key")
                    .await?;
                Err(PayError::NotConnected)
            }
        }
        other => other.map_err(Into::into),
    }
}
