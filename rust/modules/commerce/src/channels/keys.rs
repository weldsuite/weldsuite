//! `/api/commerce-channels/:id/keys`: a storefront channel's API keys (ADR
//! COM-011). A secret is `wcp_` (publishable, for browsers, bound to its
//! allowed origins) or `wcs_` (private, for the merchant's server) followed
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
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use weldsuite_catalogs::entity_events::{
    COMMERCE_CHANNEL_KEY_CREATED, COMMERCE_CHANNEL_KEY_REVOKED, COMMERCE_CHANNEL_KEY_ROTATED,
    COMMERCE_CHANNEL_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMMERCE_CHANNELS_READ, COMMERCE_CHANNELS_UPDATE};
use weldsuite_kit::portal::tokens::{random_token, sha256_hex};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::registry::{NewKey, Registry};
use super::{conflict, find};
use crate::wire::{body_or_empty, invalid, iso};
use crate::{Caller, CommerceState, Refusal, now, validate};

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
    let lead = if kind == "publishable" {
        "wcp_"
    } else {
        "wcs_"
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

const SELECT: &str = "select jsonb_build_object('id', k.id, 'channelId', k.channel_id, \
       'kind', k.kind, 'name', coalesce(k.name, ''), 'keyPrefix', k.key_prefix, \
       'allowedOrigins', k.allowed_origins, 'createdAt', to_jsonb(k.created_at), \
       'lastUsedAt', to_jsonb(k.last_used_at), 'revokedAt', to_jsonb(k.revoked_at), \
       'rotatedFromId', k.rotated_from_id) from commerce_channel_keys k";

fn present(mut row: Value) -> Value {
    for key in ["createdAt", "lastUsedAt", "revokedAt"] {
        let stamp = iso(&row[key]);
        row[key] = stamp;
    }
    row
}

async fn find_key(
    conn: &mut PgConnection,
    channel_id: &str,
    key_id: &str,
    lock: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let tail = if lock { " for update of k" } else { "" };
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{SELECT} where k.id = $1 and k.channel_id = $2{tail}"
    )))
    .bind(key_id)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(present))
}

fn event(key: &Value) -> Value {
    // Never the secret, its hash or its prefix.
    json!({
        "id": key["id"], "channelId": key["channelId"],
        "kind": key["kind"], "name": key["name"],
    })
}

/// The channel is there and is a storefront (the only channel with keys).
async fn storefront(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: &str,
) -> Result<Value, Refusal> {
    let Some(channel) = find(tx, channel_id, false).await? else {
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
fn undone(step: &str, result: Result<(), sqlx::Error>) {
    if let Err(error) = result {
        tracing::error!(%error, "[commerce] storefront key registry: could not undo {step}");
    }
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list keys";
    let result = async {
        let mut tx = caller.db.begin().await?;
        let channel = find(&mut tx, &id, false).await?;
        if channel.is_none() {
            return Err(Refusal::not_found("Channel", &id));
        }
        let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "{SELECT} where k.channel_id = $1 order by k.created_at desc, k.id desc"
        )))
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?;
        let mut rows: Vec<Value> = rows.into_iter().map(present).collect();
        // The storefront records use in the registry.
        if let Ok(registry) = Registry::of(&caller) {
            match registry.last_used(&id).await {
                Ok(used) => {
                    for row in &mut rows {
                        let seen = used
                            .iter()
                            .find(|(key, _)| row["id"] == key.as_str())
                            .and_then(|(_, at)| at.as_deref())
                            .map(|at| json!(crate::table::js_date(at)));
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
                &["publishable", "private"],
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
        storefront(&mut tx, &id).await?;
        let registry = Registry::of(&caller)?;
        let key_id = generate_id("ckey");
        let secret = generate(&body.kind);
        let stamp = now();
        registry
            .insert(&NewKey {
                id: &key_id,
                hash: &secret.hash,
                kind: &body.kind,
                prefix: &secret.prefix,
                channel_id: &id,
                origins: &body.origins,
                rotated_from: None,
                at: &stamp,
            })
            .await?;
        let written = async {
            insert_tenant(
                &mut tx,
                &key_id,
                &id,
                &body,
                &secret,
                None,
                &caller.user_id,
                &stamp,
            )
            .await?;
            let row = find_key(&mut tx, &id, &key_id, false).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(row)
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
    if kind == "private" && !origins.is_empty() {
        return Err(invalid(
            "allowedOrigins",
            "A private key has no allowed origins",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_tenant(
    tx: &mut Transaction<'_, Postgres>,
    key_id: &str,
    channel_id: &str,
    body: &NewKeyBody,
    secret: &Secret,
    rotated_from: Option<&str>,
    user_id: &str,
    stamp: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into commerce_channel_keys (id, channel_id, kind, name, key_hash, key_prefix, \
           allowed_origins, rotated_from_id, created_by, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(key_id)
    .bind(channel_id)
    .bind(&body.kind)
    .bind(&body.name)
    .bind(&secret.hash)
    .bind(&secret.prefix)
    .bind(json!(body.origins))
    .bind(rotated_from)
    .bind(user_id)
    .bind(stamp)
    .execute(&mut **tx)
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
        storefront(&mut tx, &id).await?;
        let Some(old) = find_key(&mut tx, &id, &key_id, true).await? else {
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
        let stamp = now();
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
                    at: &stamp,
                },
            )
            .await?;
        let written = async {
            insert_tenant(
                &mut tx,
                &new_id,
                &id,
                &body,
                &secret,
                Some(&key_id),
                &caller.user_id,
                &stamp,
            )
            .await?;
            sqlx::query(
                "update commerce_channel_keys set revoked_at = $2::timestamp, \
                   updated_at = $2::timestamp where id = $1",
            )
            .bind(&key_id)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
            let row = find_key(&mut tx, &id, &new_id, false).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(row)
        }
        .await;
        match written {
            Ok(Some(row)) => Ok((row, secret.secret, key_id.clone())),
            other => {
                undone("a rotation", registry.delete(&new_id).await);
                undone("a rotation", registry.unrevoke(&key_id, &stamp).await);
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
        storefront(&mut tx, &id).await?;
        let Some(key) = find_key(&mut tx, &id, &key_id, true).await? else {
            return Err(Refusal::not_found("Key", &key_id));
        };
        if revoked(&key) {
            return Err(key_revoked());
        }
        let kind = key["kind"].as_str().unwrap_or_default().to_owned();
        let old_origins = super::strings(&key["allowedOrigins"]);
        let new_origins = origins.clone().unwrap_or_else(|| old_origins.clone());
        origins_fit(&kind, &new_origins)?;
        let stamp = now();
        let moved = origins.is_some() && new_origins != old_origins;
        let registry = if moved {
            Some(Registry::of(&caller)?)
        } else {
            None
        };
        if let Some(registry) = &registry {
            registry.set_origins(&key_id, &new_origins, &stamp).await?;
        }
        let written = async {
            sqlx::query(
                "update commerce_channel_keys set name = coalesce($2, name), \
                   allowed_origins = $3::jsonb, updated_at = $4::timestamp where id = $1",
            )
            .bind(&key_id)
            .bind(name.as_deref())
            .bind(json!(new_origins))
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
            let row = find_key(&mut tx, &id, &key_id, false).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(row)
        }
        .await;
        match written {
            Ok(Some(row)) => Ok(row),
            other => {
                if let Some(registry) = &registry {
                    undone(
                        "an origin change",
                        registry.set_origins(&key_id, &old_origins, &stamp).await,
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
        storefront(&mut tx, &id).await?;
        let Some(key) = find_key(&mut tx, &id, &key_id, true).await? else {
            return Err(Refusal::not_found("Key", &key_id));
        };
        let registry = Registry::of(&caller)?;
        let stamp = now();
        // The registry first: from here the key is refused. If the tenant
        // write below fails, revoking again finishes the job.
        registry.revoke(&key_id, &stamp).await?;
        sqlx::query(
            "update commerce_channel_keys set revoked_at = coalesce(revoked_at, $2::timestamp), \
               updated_at = $2::timestamp where id = $1",
        )
        .bind(&key_id)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
        let fresh = find_key(&mut tx, &id, &key_id, false).await?;
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
