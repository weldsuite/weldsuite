//! `/api/commerce-channels/:id/keys`: a storefront channel's API keys (ADR
//! COM-011). A secret is `wcp_` (publishable, for browsers, bound to its
//! allowed origins), `wcs_` (private, for the merchant's server) or `wcd_`
//! (deploy: uploads a shop the merchant builds to WeldSuite's hosting) followed
//! by 32 random bytes in base62. It is shown once, when the key is created or
//! rotated; only its SHA-256 is stored, in the tenant `commerce_channel_keys`
//! and in the master `storefront_key_registry` ([`super::registry`]).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    COMMERCE_CHANNEL_KEY_CREATED, COMMERCE_CHANNEL_KEY_REVOKED, COMMERCE_CHANNEL_KEY_ROTATED,
    COMMERCE_CHANNEL_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMMERCE_CHANNELS_READ, COMMERCE_CHANNELS_UPDATE};
use weldsuite_db::{OrmConn, utc_now};
use weldsuite_kit::portal::tokens::{random_token, sha256_hex};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::commerce_channel_keys;

use super::registry::{NewKey, Registry};
use super::{conflict, find};
use crate::args::{iso, iso_or_null};
use crate::wire::{body_or_empty, invalid};
use crate::{Caller, CommerceState, Refusal, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let write = || gate.require([COMMERCE_CHANNELS_UPDATE]);
    Router::new()
        .route(
            "/{id}/keys",
            get(list).route_layer(gate.require([COMMERCE_CHANNELS_READ])),
        )
        .route("/{id}/keys", post(create).route_layer(write()))
        .route("/{id}/keys/{key_id}", patch(edit).route_layer(write()))
        .route(
            "/{id}/keys/{key_id}/rotate",
            post(rotate).route_layer(write()),
        )
        .route(
            "/{id}/keys/{key_id}/revoke",
            post(revoke).route_layer(write()),
        )
}

// ── secrets ─────────────────────────────────────────────────────────────────

const ALPHABET: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// `bytes` (a big-endian number) in base62.
fn base62(bytes: &[u8]) -> String {
    let mut number = bytes.to_vec();
    let mut digits = Vec::new();
    while number.iter().any(|byte| *byte != 0) {
        let mut remainder = 0u32;
        for byte in &mut number {
            let current = (remainder << 8) | u32::from(*byte);
            *byte = u8::try_from(current / 62).unwrap_or(0);
            remainder = current % 62;
        }
        digits.push(ALPHABET[usize::try_from(remainder).unwrap_or(0)]);
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// 32 random bytes from the operating system.
fn random_bytes() -> Vec<u8> {
    random_token(32)
        .as_bytes()
        .chunks(2)
        .filter_map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        })
        .collect()
}

/// A new secret for `kind`: the secret, its hash and its prefix.
#[allow(clippy::struct_field_names)]
struct Secret {
    secret: String,
    hash: String,
    prefix: String,
}

fn generate(kind: &str) -> Secret {
    let lead = match kind {
        "publishable" => "wcp_",
        // Uploads a shop the merchant builds (storefronts plan, phase 6).
        "deploy" => "wcd_",
        _ => "wcs_",
    };
    let secret = format!("{lead}{}", base62(&random_bytes()));
    Secret {
        hash: sha256_hex(&secret),
        prefix: secret.chars().take(16).collect(),
        secret,
    }
}

// ── origins ─────────────────────────────────────────────────────────────────

/// An exact origin, `https://host[:port]` (`http://` only for localhost and
/// 127.0.0.1), as it is stored: lower-case, no path, no wildcard.
fn normalise_origin(text: &str) -> Option<String> {
    let text = text.trim().to_ascii_lowercase();
    let (scheme, authority) = text.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if let Some(port) = port {
        let number: u32 = port.parse().ok()?;
        if port.is_empty() || !(1..=65535).contains(&number) || port.starts_with('0') {
            return None;
        }
    }
    let local = host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost");
    if scheme == "http" && !local {
        return None;
    }
    let labels_ok = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    labels_ok.then(|| text.clone())
}

fn read_origins(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Vec<String>> {
    issues
        .list(
            fields,
            "allowedOrigins",
            Presence::Optional,
            None,
            Some(20),
            |issues, item| {
                issues
                    .item_pattern(
                        item,
                        Text::trimmed(Some(1), Some(255)),
                        |origin| normalise_origin(origin).is_some(),
                        "Must be an exact origin like https://shop.example.com",
                    )
                    .and_then(|origin| normalise_origin(&origin))
            },
        )
        .into_option()
        .map(|mut origins| {
            let mut seen = Vec::new();
            origins.retain(|origin| {
                let fresh = !seen.contains(origin);
                seen.push(origin.clone());
                fresh
            });
            origins
        })
}

// ── presenting ──────────────────────────────────────────────────────────────

/// A key as the API answers it: never its hash.
fn present(key: &commerce_channel_keys::Model) -> Value {
    json!({
        "id": key.id,
        "channelId": key.channel_id,
        "kind": key.kind,
        "name": key.name.as_deref().unwrap_or_default(),
        "keyPrefix": key.key_prefix,
        "allowedOrigins": key.allowed_origins,
        "createdAt": iso(key.created_at),
        "lastUsedAt": iso_or_null(key.last_used_at),
        "revokedAt": iso_or_null(key.revoked_at),
        "rotatedFromId": key.rotated_from_id,
    })
}

async fn find_key<C: ConnectionTrait>(
    db: &C,
    channel_id: &str,
    key_id: &str,
    lock: bool,
) -> Result<Option<Value>, DbErr> {
    let mut found = commerce_channel_keys::Entity::find_by_id(key_id)
        .filter(commerce_channel_keys::Column::ChannelId.eq(channel_id));
    if lock {
        found = found.lock_exclusive();
    }
    Ok(found.one(db).await?.as_ref().map(present))
}

fn event(key: &Value) -> Value {
    // Never the secret, its hash or its prefix.
    json!({
        "id": key["id"], "channelId": key["channelId"],
        "kind": key["kind"], "name": key["name"],
    })
}

/// The channel is there and is a storefront (the only channel with keys).
async fn storefront<C: ConnectionTrait>(db: &C, channel_id: &str) -> Result<Value, Refusal> {
    let Some(channel) = find(db, channel_id, false).await? else {
        return Err(Refusal::not_found("Channel", channel_id));
    };
    if channel["type"] != "storefront" {
        return Err(conflict(
            "KEYS_NOT_SUPPORTED",
            "Only storefront channels have API keys",
            None,
        ));
    }
    Ok(channel)
}

fn revoked(key: &Value) -> bool {
    !key["revokedAt"].is_null()
}

fn key_revoked() -> Refusal {
    conflict("KEY_REVOKED", "This key is revoked", None)
}

/// Undo what a failed sequence did to the registry, and say so when even
/// that fails (the key is then unusable anyway: nobody holds its secret).
fn undone(step: &str, result: Result<(), DbErr>) {
    if let Err(error) = result {
        tracing::error!(%error, "[commerce] storefront key registry: could not undo {step}");
    }
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list keys";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        let channel = find(&db, &id, false).await?;
        if channel.is_none() {
            return Err(Refusal::not_found("Channel", &id));
        }
        let mut rows: Vec<Value> = commerce_channel_keys::Entity::find()
            .filter(commerce_channel_keys::Column::ChannelId.eq(id.as_str()))
            .order_by_desc(commerce_channel_keys::Column::CreatedAt)
            .order_by_desc(commerce_channel_keys::Column::Id)
            .all(&db)
            .await?
            .iter()
            .map(present)
            .collect();
        // The storefront records use in the registry.
        if let Ok(registry) = Registry::of(&caller) {
            match registry.last_used(&id).await {
                Ok(used) => {
                    for row in &mut rows {
                        let seen = used
                            .iter()
                            .find(|(key, _)| row["id"] == key.as_str())
                            .and_then(|(_, at)| *at)
                            .map(|at| json!(iso(at)));
                        if let Some(seen) = seen
                            && row["lastUsedAt"]
                                .as_str()
                                .is_none_or(|own| own < seen.as_str().unwrap_or_default())
                        {
                            row["lastUsedAt"] = seen;
                        }
                    }
                }
                Err(error) => tracing::warn!(%error, "[commerce] key last use unavailable"),
            }
        }
        Ok(rows)
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

struct NewKeyBody {
    kind: String,
    name: String,
    origins: Vec<String>,
}

#[allow(clippy::too_many_lines)]
async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create key";
    let body = match validate(&headers, &body, |issues, fields| NewKeyBody {
        kind: issues
            .choice(
                fields,
                "kind",
                Presence::Required,
                &["publishable", "private", "deploy"],
            )
            .into_option()
            .unwrap_or_default(),
        name: issues
            .text_with(
                fields,
                "name",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option()
            .unwrap_or_default(),
        origins: read_origins(issues, fields).unwrap_or_default(),
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        origins_fit(&body.kind, &body.origins)?;
        let mut tx = caller.db.begin().await?;
        storefront(&OrmConn::new(&mut tx), &id).await?;
        let registry = Registry::of(&caller)?;
        let key_id = generate_id("ckey");
        let secret = generate(&body.kind);
        let stamp = utc_now();
        registry
            .insert(&NewKey {
                id: &key_id,
                hash: &secret.hash,
                kind: &body.kind,
                prefix: &secret.prefix,
                channel_id: &id,
                origins: &body.origins,
                rotated_from: None,
                at: stamp,
            })
            .await?;
        let written = async {
            let db = OrmConn::new(&mut tx);
            insert_tenant(
                &db,
                &key_id,
                &id,
                &body,
                &secret,
                None,
                &caller.user_id,
                stamp,
            )
            .await?;
            let row = find_key(&db, &id, &key_id, false).await?;
            tx.commit().await.map_err(weldsuite_db::orm_error)?;
            Ok::<_, DbErr>(row)
        }
        .await;
        match written {
            Ok(Some(row)) => Ok((row, secret.secret)),
            Ok(None) => {
                undone("a new key", registry.delete(&key_id).await);
                Err(Refusal::not_found("Key", &key_id))
            }
            Err(error) => {
                undone("a new key", registry.delete(&key_id).await);
                Err(error.into())
            }
        }
    }
    .await;
    match result {
        Ok((key, secret)) => {
            caller.publish(
                &state,
                COMMERCE_CHANNEL_KEY_CREATED,
                key["id"].as_str().unwrap_or_default(),
                &event(&key),
            );
            Created(json!({ "key": key, "secret": secret })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The origin rule of a kind: a publishable key needs one, a private key has none.
fn origins_fit(kind: &str, origins: &[String]) -> Result<(), Refusal> {
    if kind == "publishable" && origins.is_empty() {
        return Err(invalid(
            "allowedOrigins",
            "A publishable key needs at least one allowed origin",
        ));
    }
    if kind != "publishable" && !origins.is_empty() {
        return Err(invalid(
            "allowedOrigins",
            "Only a publishable key has allowed origins",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_tenant<C: ConnectionTrait>(
    db: &C,
    key_id: &str,
    channel_id: &str,
    body: &NewKeyBody,
    secret: &Secret,
    rotated_from: Option<&str>,
    user_id: &str,
    stamp: PrimitiveDateTime,
) -> Result<(), DbErr> {
    commerce_channel_keys::Entity::insert(commerce_channel_keys::ActiveModel {
        id: Set(key_id.to_owned()),
        channel_id: Set(channel_id.to_owned()),
        kind: Set(body.kind.clone()),
        name: Set(Some(body.name.clone())),
        key_hash: Set(secret.hash.clone()),
        key_prefix: Set(secret.prefix.clone()),
        allowed_origins: Set(json!(body.origins)),
        rotated_from_id: Set(rotated_from.map(str::to_owned)),
        created_by: Set(Some(user_id.to_owned())),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;
    Ok(())
}

async fn rotate(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, key_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to rotate key";
    let result = async {
        let mut tx = caller.db.begin().await?;
        storefront(&OrmConn::new(&mut tx), &id).await?;
        let Some(old) = find_key(&OrmConn::new(&mut tx), &id, &key_id, true).await? else {
            return Err(Refusal::not_found("Key", &key_id));
        };
        if revoked(&old) {
            return Err(key_revoked());
        }
        let registry = Registry::of(&caller)?;
        let body = NewKeyBody {
            kind: old["kind"].as_str().unwrap_or_default().to_owned(),
            name: old["name"].as_str().unwrap_or_default().to_owned(),
            origins: super::strings(&old["allowedOrigins"]),
        };
        let new_id = generate_id("ckey");
        let secret = generate(&body.kind);
        let stamp = utc_now();
        registry
            .rotate(
                &key_id,
                &NewKey {
                    id: &new_id,
                    hash: &secret.hash,
                    kind: &body.kind,
                    prefix: &secret.prefix,
                    channel_id: &id,
                    origins: &body.origins,
                    rotated_from: Some(&key_id),
                    at: stamp,
                },
            )
            .await?;
        let written = async {
            let db = OrmConn::new(&mut tx);
            insert_tenant(
                &db,
                &new_id,
                &id,
                &body,
                &secret,
                Some(&key_id),
                &caller.user_id,
                stamp,
            )
            .await?;
            commerce_channel_keys::Entity::update_many()
                .col_expr(commerce_channel_keys::Column::RevokedAt, Expr::val(stamp))
                .col_expr(commerce_channel_keys::Column::UpdatedAt, Expr::val(stamp))
                .filter(commerce_channel_keys::Column::Id.eq(key_id.as_str()))
                .exec(&db)
                .await?;
            let row = find_key(&db, &id, &new_id, false).await?;
            tx.commit().await.map_err(weldsuite_db::orm_error)?;
            Ok::<_, DbErr>(row)
        }
        .await;
        match written {
            Ok(Some(row)) => Ok((row, secret.secret, key_id.clone())),
            other => {
                undone("a rotation", registry.delete(&new_id).await);
                undone("a rotation", registry.unrevoke(&key_id, stamp).await);
                match other {
                    Err(error) => Err(error.into()),
                    _ => Err(Refusal::not_found("Key", &new_id)),
                }
            }
        }
    }
    .await;
    match result {
        Ok((key, secret, old_id)) => {
            let mut data = event(&key);
            data["rotatedFromId"] = json!(old_id);
            caller.publish(
                &state,
                COMMERCE_CHANNEL_KEY_ROTATED,
                key["id"].as_str().unwrap_or_default(),
                &data,
            );
            Created(json!({ "key": key, "secret": secret })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn edit(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, key_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update key";
    let (headers, body) = body_or_empty(&headers, &body);
    let (name, origins) = match validate(&headers, &body, |issues, fields| {
        (
            issues
                .text_with(
                    fields,
                    "name",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(255)),
                )
                .into_option(),
            read_origins(issues, fields),
        )
    }) {
        Ok(parts) => parts,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let mut tx = caller.db.begin().await?;
        storefront(&OrmConn::new(&mut tx), &id).await?;
        let Some(key) = find_key(&OrmConn::new(&mut tx), &id, &key_id, true).await? else {
            return Err(Refusal::not_found("Key", &key_id));
        };
        if revoked(&key) {
            return Err(key_revoked());
        }
        let kind = key["kind"].as_str().unwrap_or_default().to_owned();
        let old_origins = super::strings(&key["allowedOrigins"]);
        let new_origins = origins.clone().unwrap_or_else(|| old_origins.clone());
        origins_fit(&kind, &new_origins)?;
        let stamp = utc_now();
        let moved = origins.is_some() && new_origins != old_origins;
        let registry = if moved {
            Some(Registry::of(&caller)?)
        } else {
            None
        };
        if let Some(registry) = &registry {
            registry.set_origins(&key_id, &new_origins, stamp).await?;
        }
        let written = async {
            let db = OrmConn::new(&mut tx);
            // `name = coalesce($name, name)`: a name the body left out stays.
            let mut update = commerce_channel_keys::Entity::update_many();
            if let Some(name) = &name {
                update = update.col_expr(
                    commerce_channel_keys::Column::Name,
                    Expr::val(name.as_str()),
                );
            }
            update
                .col_expr(
                    commerce_channel_keys::Column::AllowedOrigins,
                    Expr::val(json!(new_origins)),
                )
                .col_expr(commerce_channel_keys::Column::UpdatedAt, Expr::val(stamp))
                .filter(commerce_channel_keys::Column::Id.eq(key_id.as_str()))
                .exec(&db)
                .await?;
            let row = find_key(&db, &id, &key_id, false).await?;
            tx.commit().await.map_err(weldsuite_db::orm_error)?;
            Ok::<_, DbErr>(row)
        }
        .await;
        match written {
            Ok(Some(row)) => Ok(row),
            other => {
                if let Some(registry) = &registry {
                    undone(
                        "an origin change",
                        registry.set_origins(&key_id, &old_origins, stamp).await,
                    );
                }
                match other {
                    Err(error) => Err(error.into()),
                    _ => Err(Refusal::not_found("Key", &key_id)),
                }
            }
        }
    }
    .await;
    match result {
        Ok(key) => {
            // The catalog has no key "updated"; the channel's refreshes the screens.
            caller.publish(
                &state,
                COMMERCE_CHANNEL_UPDATED,
                &id,
                &json!({ "id": id, "keyId": key["id"] }),
            );
            Data(key).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn revoke(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, key_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to revoke key";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let db = OrmConn::new(&mut tx);
        storefront(&db, &id).await?;
        let Some(key) = find_key(&db, &id, &key_id, true).await? else {
            return Err(Refusal::not_found("Key", &key_id));
        };
        let registry = Registry::of(&caller)?;
        let stamp = utc_now();
        // The registry first: from here the key is refused. If the tenant
        // write below fails, revoking again finishes the job.
        registry.revoke(&key_id, stamp).await?;
        commerce_channel_keys::Entity::update_many()
            .col_expr(
                commerce_channel_keys::Column::RevokedAt,
                Func::coalesce([
                    Expr::col((
                        commerce_channel_keys::Entity,
                        commerce_channel_keys::Column::RevokedAt,
                    )),
                    Expr::val(stamp),
                ])
                .into(),
            )
            .col_expr(commerce_channel_keys::Column::UpdatedAt, Expr::val(stamp))
            .filter(commerce_channel_keys::Column::Id.eq(key_id.as_str()))
            .exec(&db)
            .await?;
        let fresh = find_key(&db, &id, &key_id, false).await?;
        tx.commit().await?;
        Ok((fresh.unwrap_or(key.clone()), revoked(&key)))
    }
    .await;
    match result {
        Ok((key, already)) => {
            if !already {
                caller.publish(&state, COMMERCE_CHANNEL_KEY_REVOKED, &key_id, &event(&key));
            }
            Data(key).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_prefixed_hashed_and_distinct() {
        let a = generate("publishable");
        let b = generate("private");
        assert!(a.secret.starts_with("wcp_"));
        assert!(b.secret.starts_with("wcs_"));
        assert_ne!(a.secret, generate("publishable").secret);
        assert_eq!(a.prefix, a.secret[..16]);
        assert_eq!(a.hash, sha256_hex(&a.secret));
        assert!(a.secret[4..].bytes().all(|c| c.is_ascii_alphanumeric()));
        assert!(a.secret.len() >= 4 + 40);
    }

    #[test]
    fn base62_of_known_numbers() {
        assert_eq!(base62(&[61]), "z");
        assert_eq!(base62(&[1, 0]), "48"); // 256 = 4 * 62 + 8
    }

    #[test]
    fn origins_are_exact() {
        for good in [
            "https://shop.example.com",
            "HTTPS://Shop.Example.com:8443",
            "http://localhost:3000",
            "http://localhost",
            "https://localhost:5173",
        ] {
            assert!(normalise_origin(good).is_some(), "{good}");
        }
        for bad in [
            "http://shop.example.com",
            "https://shop.example.com/",
            "https://shop.example.com/path",
            "https://*.example.com",
            "shop.example.com",
            "https://",
            "https://shop.example.com:0",
            "https://user@shop.example.com",
            "ftp://shop.example.com",
            "https://-bad.example.com",
        ] {
            assert!(normalise_origin(bad).is_none(), "{bad}");
        }
        assert_eq!(
            normalise_origin("HTTPS://Shop.Example.com:8443").as_deref(),
            Some("https://shop.example.com:8443")
        );
    }
}
