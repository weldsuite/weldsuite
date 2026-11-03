//! `connectors/connections.ts`: connector connections
//! (`connector_connections`), their stored credentials (each value sealed
//! with the workspace keyring), the shape the client sees, sync runs and the
//! records a connection imported.

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, js_row};

use crate::catalog::{get_connector, syncs};

/// `keyringFromEnv(env)`: `DATABASE_ENCRYPTION_KEY` and `_V2`, empty as unset.
pub fn keyring(v1: Option<String>, v2: Option<String>) -> Keyring {
    Keyring {
        v1: v1.filter(|k| !k.is_empty()),
        v2: v2.filter(|k| !k.is_empty()),
    }
}

/// `encryptCredentials(credentials, keyring)`: every non-empty value sealed
/// (stored as it is when the keyring has no key).
pub fn encrypt_credentials(
    credentials: &Map<String, Value>,
    keyring: &Keyring,
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for (key, value) in credentials {
        let Some(text) = value.as_str().filter(|t| !t.is_empty()) else {
            continue;
        };
        let stored = if keyring.v1.is_some() || keyring.v2.is_some() {
            weldsuite_db::encrypt_field(text, keyring).map_err(|error| error.to_string())?
        } else {
            text.to_owned()
        };
        out.insert(key.clone(), json!(stored));
    }
    Ok(out)
}

pub use crate::clients::decrypt_credentials;

/// `getConnectionById(db, id)`: the row (`to_jsonb`, `snake_case`), not deleted.
pub async fn get_connection(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(c) from connector_connections c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

/// `listConnections(db)`: newest first.
pub async fn list_connections(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(c) from connector_connections c where c.deleted_at is null
         order by c.created_at desc",
    )
    .fetch_all(db)
    .await
}

fn or_value(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    }
}

/// `sanitizeConnection(row, { entityId })`: the allow-listed fields the
/// client may see, from a `to_jsonb` row.
pub fn sanitize_connection(row: &Value, entity_id: Option<&str>) -> Value {
    let row = js_row(row.clone());
    let provider = row["provider"].as_str().unwrap_or_default();
    let connector = get_connector(provider);
    let def = |key: &str, fallback: &str| {
        connector
            .and_then(|c| c[key].as_str())
            .unwrap_or(fallback)
            .to_owned()
    };
    let setting_keys: Vec<Value> = connector
        .map(|c| syncs(c).iter().map(|s| s["settingKey"].clone()).collect())
        .unwrap_or_default();
    let auth_fields: Vec<Value> = connector
        .and_then(|c| c["auth"]["fields"].as_array())
        .map(|fields| {
            fields
                .iter()
                .map(|f| {
                    let mut field = Map::new();
                    field.insert("key".to_owned(), f["key"].clone());
                    field.insert("label".to_owned(), f["label"].clone());
                    field.insert("type".to_owned(), f["type"].clone());
                    if let Some(placeholder) = f.get("placeholder").filter(|p| !p.is_null()) {
                        field.insert("placeholder".to_owned(), placeholder.clone());
                    }
                    field.insert(
                        "required".to_owned(),
                        or_value(f.get("required"), json!(true)),
                    );
                    Value::Object(field)
                })
                .collect()
        })
        .unwrap_or_default();
    let sync_list: Vec<Value> = connector
        .map(|c| {
            syncs(c)
                .iter()
                .map(|s| {
                    json!({
                        "syncName": s["syncName"],
                        "model": s["model"],
                        "internalEntity": s["internalEntity"],
                        "settingKey": s["settingKey"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let status = row["status"].as_str().unwrap_or_default();
    let label = connector.map_or_else(|| json!(provider), |c| c["label"].clone());
    json!({
        "id": row["id"],
        "provider": row["provider"],
        "label": label,
        "icon": def("icon", "plug"),
        "category": def("category", "ecommerce"),
        "displayName": row["displayName"],
        "status": row["status"],
        "externalAccountId": row["externalAccountId"],
        "entityId": entity_id,
        "enabledSyncs": or_value(row.get("enabledSyncs"), Value::Array(setting_keys)),
        "settings": or_value(row.get("settings"), json!({})),
        "direction": or_value(row.get("direction"), json!("inbound")),
        "objectSyncDirections": or_value(row.get("objectSyncDirections"), json!({})),
        "authFields": auth_fields,
        "syncs": sync_list,
        "lastSyncAt": row["lastSyncAt"],
        "lastSyncStatus": row["lastSyncStatus"],
        "lastError": row["lastError"],
        "lastErrorAt": row["lastErrorAt"],
        "recordsSynced": row["recordsSynced"],
        "connectedAt": row["connectedAt"],
        "connectedBy": row["connectedBy"],
        "isConnected": status != "pending" && row["deletedAt"].is_null(),
        "webhookCount": row["webhookRegistrations"].as_array().map_or(0, Vec::len),
    })
}

/// `sanitizeConnectionWithEntity(row, keyring)`: with the WeldBooks entity
/// the credentials bind.
pub fn sanitize_with_entity(row: &Value, keyring: &Keyring) -> Value {
    let credentials = decrypt_credentials(row.get("credentials"), keyring);
    let entity = credentials
        .get("entityId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty());
    sanitize_connection(row, entity)
}

/// `listSyncRuns(db, connectionId, limit)`: newest first.
pub async fn list_sync_runs(
    db: &PgPool,
    connection_id: &str,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from connector_sync_runs r where r.connection_id = $1
         order by r.created_at desc limit $2",
    )
    .bind(connection_id)
    .bind(limit.min(100))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `listConnectionRecords(db, connectionId, limit)`: the latest entity
/// mappings with a label read from the record each points at.
pub async fn list_connection_records(
    db: &PgPool,
    connection_id: &str,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let mappings: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', m.id, 'externalEntityType', m.external_entity_type,
             'externalEntityId', m.external_entity_id, 'internalEntityType', m.internal_entity_type,
             'internalEntityId', m.internal_entity_id, 'lastSyncedAt', m.last_synced_at,
             'updatedAt', m.updated_at)
         from integration_entity_mappings m where m.connection_id = $1
         order by m.updated_at desc limit $2",
    )
    .bind(connection_id)
    .bind(limit.min(100))
    .fetch_all(db)
    .await?;
    let mappings: Vec<Value> = mappings.into_iter().map(js_row).collect();
    let ids_for = |kind: &str| -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for m in &mappings {
            if m["internalEntityType"].as_str() == Some(kind)
                && let Some(id) = m["internalEntityId"].as_str()
                && !ids.iter().any(|i| i == id)
            {
                ids.push(id.to_owned());
            }
        }
        ids
    };
    // (type, the label SQL over `t`, the table).
    let lookups: [(&str, &str); 9] = [
        ("party", "select t.id, t.display_name from parties t where t.id = any($1)"),
        ("product", "select t.id, t.name from products t where t.id = any($1)"),
        (
            "person",
            "select t.id, coalesce(nullif(btrim(coalesce(t.full_name, '')), ''),
                 nullif(concat_ws(' ', nullif(t.first_name, ''), nullif(t.last_name, '')), ''))
             from people t where t.id = any($1)",
        ),
        ("company", "select t.id, t.display_name from companies t where t.id = any($1)"),
        (
            "invoice",
            "select t.id, coalesce(nullif(t.invoice_number, ''), nullif(t.contact_name, ''), nullif(t.reference, ''))
             from invoices t where t.id = any($1)",
        ),
        (
            "bill",
            "select t.id, coalesce(nullif(t.bill_number, ''), nullif(t.contact_name, ''), nullif(t.reference, ''))
             from bills t where t.id = any($1)",
        ),
        ("order", "select t.id, t.order_number from orders t where t.id = any($1)"),
        ("bank_account", "select t.id, t.name from bank_accounts t where t.id = any($1)"),
        (
            "bank_transaction",
            "select t.id, coalesce(nullif(t.description, ''), nullif(t.reference, ''), t.amount::text)
             from bank_transactions t where t.id = any($1)",
        ),
    ];
    let mut labels: Vec<(String, String, String)> = Vec::new();
    for (kind, sql) in lookups {
        let ids = ids_for(kind);
        if ids.is_empty() {
            continue;
        }
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .bind(&ids)
            .fetch_all(db)
            .await?;
        for (id, label) in rows {
            if let Some(label) = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()) {
                labels.push((kind.to_owned(), id, label));
            }
        }
    }
    Ok(mappings
        .iter()
        .map(|m| {
            let kind = m["internalEntityType"].as_str().unwrap_or_default();
            let id = m["internalEntityId"].as_str().unwrap_or_default();
            let label = labels
                .iter()
                .find(|(k, i, _)| k == kind && i == id)
                .map_or_else(|| m["externalEntityId"].clone(), |(_, _, l)| json!(l));
            let synced = match &m["lastSyncedAt"] {
                Value::Null => m["updatedAt"].clone(),
                at => at.clone(),
            };
            json!({
                "id": m["id"],
                "externalEntityType": m["externalEntityType"],
                "externalEntityId": m["externalEntityId"],
                "internalEntityType": m["internalEntityType"],
                "internalEntityId": m["internalEntityId"],
                "label": label,
                "lastSyncedAt": synced,
            })
        })
        .collect())
}

// ── writes (`connectors/connections.ts`) ────────────────────────────────────

/// `encryptWebhookSecret(secret, keyring)`: sealed, or as it is without a key.
pub fn encrypt_webhook_secret(secret: &str, keyring: &Keyring) -> Result<String, String> {
    if keyring.v1.is_some() || keyring.v2.is_some() {
        weldsuite_db::encrypt_field(secret, keyring).map_err(|error| error.to_string())
    } else {
        Ok(secret.to_owned())
    }
}

/// `maybeDecryptWebhookSecret(secret, keyring)`.
pub fn maybe_decrypt_webhook_secret(secret: Option<&str>, keyring: &Keyring) -> Option<String> {
    let secret = secret.filter(|s| !s.is_empty())?;
    Some(crate::crypto::maybe_decrypt_field(secret, keyring))
}

/// `findConnectionByProviderAccount(db, provider, externalAccountId)`:
/// deleted rows included.
pub async fn find_by_provider_account(
    db: &PgPool,
    provider: &str,
    external_account_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(c) from connector_connections c
         where c.provider = $1 and c.external_account_id = $2 limit 1",
    )
    .bind(provider)
    .bind(external_account_id)
    .fetch_optional(db)
    .await
}

/// What `upsertConnection` writes.
pub struct NewConnection<'a> {
    pub provider: &'a str,
    pub display_name: &'a str,
    pub user_id: &'a str,
    pub credentials: &'a Map<String, Value>,
    pub enabled_syncs: &'a [String],
    pub external_account_id: Option<&'a str>,
    pub webhook_secret: Option<&'a str>,
}

/// `upsertConnection(...)`: revives the row of the same provider account,
/// else inserts one. The row (`to_jsonb`).
pub async fn upsert_connection(db: &PgPool, new: &NewConnection<'_>) -> Result<Value, sqlx::Error> {
    let now = crate::js::now_iso();
    let existing = match new.external_account_id {
        Some(account) => find_by_provider_account(db, new.provider, account).await?,
        None => None,
    };
    let id = if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        sqlx::query(
            "update connector_connections set display_name = $1, credentials = $2, enabled_syncs = $3,
               external_account_id = $4, webhook_secret = coalesce($5, webhook_secret), status = 'active',
               deleted_at = null, disconnected_at = null, last_error = null, last_error_at = null,
               connected_at = $6::timestamp, connected_by = $7, updated_at = $6::timestamp
             where id = $8",
        )
        .bind(new.display_name)
        .bind(Value::Object(new.credentials.clone()))
        .bind(json!(new.enabled_syncs))
        .bind(new.external_account_id)
        .bind(new.webhook_secret)
        .bind(&now)
        .bind(new.user_id)
        .bind(&id)
        .execute(db)
        .await?;
        id
    } else {
        let id = weldsuite_kit::generate_id("conn");
        sqlx::query(
            "insert into connector_connections (id, provider, display_name, credentials, enabled_syncs,
               external_account_id, webhook_secret, status, connected_at, connected_by)
             values ($1, $2, $3, $4, $5, $6, $7, 'active', $8::timestamp, $9)",
        )
        .bind(&id)
        .bind(new.provider)
        .bind(new.display_name)
        .bind(Value::Object(new.credentials.clone()))
        .bind(json!(new.enabled_syncs))
        .bind(new.external_account_id)
        .bind(new.webhook_secret)
        .bind(&now)
        .bind(new.user_id)
        .execute(db)
        .await?;
        id
    };
    Ok(get_connection(db, &id).await?.unwrap_or(Value::Null))
}

/// `ensurePendingConnection(...)`: the row a merchant's authorisation
/// lands on, revived or created as `pending`.
pub async fn ensure_pending_connection(
    db: &PgPool,
    provider: &str,
    display_name: &str,
    user_id: &str,
    enabled_syncs: &[String],
    external_account_id: &str,
) -> Result<Value, sqlx::Error> {
    let now = crate::js::now_iso();
    let id = if let Some(existing) =
        find_by_provider_account(db, provider, external_account_id).await?
    {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let revive = !existing["deleted_at"].is_null() || existing["status"] == "pending";
        sqlx::query(
            "update connector_connections set display_name = $1, enabled_syncs = $2, external_account_id = $3,
               deleted_at = null, disconnected_at = null,
               status = case when $4 then 'pending' else status end,
               connected_by = case when $4 then $5 else connected_by end,
               updated_at = $6::timestamp
             where id = $7",
        )
        .bind(display_name)
        .bind(json!(enabled_syncs))
        .bind(external_account_id)
        .bind(revive)
        .bind(user_id)
        .bind(&now)
        .bind(&id)
        .execute(db)
        .await?;
        id
    } else {
        let id = weldsuite_kit::generate_id("conn");
        sqlx::query(
            "insert into connector_connections (id, provider, display_name, enabled_syncs, external_account_id,
               status, connected_by)
             values ($1, $2, $3, $4, $5, 'pending', $6)",
        )
        .bind(&id)
        .bind(provider)
        .bind(display_name)
        .bind(json!(enabled_syncs))
        .bind(external_account_id)
        .bind(user_id)
        .execute(db)
        .await?;
        id
    };
    Ok(get_connection(db, &id).await?.unwrap_or(Value::Null))
}

/// `updateConnectionSettings(...)`: `None` leaves a column as it is; the
/// error is cleared and the status set to `active`.
#[derive(Default)]
pub struct SettingsUpdate {
    pub enabled_syncs: Option<Vec<String>>,
    pub direction: Option<String>,
    /// `Some(Value::Null)` clears it.
    pub object_sync_directions: Option<Value>,
    pub credentials: Option<Map<String, Value>>,
    pub display_name: Option<String>,
    /// `Some(None)` clears it.
    pub external_account_id: Option<Option<String>>,
    pub webhook_secret: Option<Option<String>>,
    pub webhook_registrations: Option<Value>,
    /// The whole settings object (`Some(Value::Null)` clears it).
    pub settings: Option<Value>,
}

pub async fn update_connection_settings(
    db: &PgPool,
    connection_id: &str,
    update: &SettingsUpdate,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update connector_connections set
           settings = case when $1 then $2 else settings end,
           enabled_syncs = case when $3 then $4 else enabled_syncs end,
           direction = case when $5 then $6 else direction end,
           object_sync_directions = case when $7 then $8 else object_sync_directions end,
           credentials = case when $9 then $10 else credentials end,
           display_name = case when $11 then $12 else display_name end,
           external_account_id = case when $13 then $14 else external_account_id end,
           webhook_secret = case when $15 then $16 else webhook_secret end,
           webhook_registrations = case when $17 then $18 else webhook_registrations end,
           last_error = null, last_error_at = null, status = 'active', updated_at = $19::timestamp
         where id = $20",
    )
    .bind(update.settings.is_some())
    .bind(update.settings.clone().filter(|v| !v.is_null()))
    .bind(update.enabled_syncs.is_some())
    .bind(update.enabled_syncs.as_ref().map(|s| json!(s)))
    .bind(update.direction.is_some())
    .bind(&update.direction)
    .bind(update.object_sync_directions.is_some())
    .bind(
        update
            .object_sync_directions
            .clone()
            .filter(|v| !v.is_null()),
    )
    .bind(update.credentials.is_some())
    .bind(update.credentials.clone().map(Value::Object))
    .bind(update.display_name.is_some())
    .bind(&update.display_name)
    .bind(update.external_account_id.is_some())
    .bind(update.external_account_id.clone().flatten())
    .bind(update.webhook_secret.is_some())
    .bind(update.webhook_secret.clone().flatten())
    .bind(update.webhook_registrations.is_some())
    .bind(
        update
            .webhook_registrations
            .clone()
            .filter(|v| !v.is_null()),
    )
    .bind(crate::js::now_iso())
    .bind(connection_id)
    .execute(db)
    .await
    .map(|_| ())
}

/// `seedDefaultConnectorFieldMappings(db, connectionId, provider)`: the
/// default mappings of every entity type the connector syncs that has none.
pub async fn seed_default_field_mappings(
    db: &PgPool,
    connection_id: &str,
    provider: &str,
) -> Result<(), sqlx::Error> {
    let Some(connector) = get_connector(provider) else {
        return Ok(());
    };
    let mut entity_types: Vec<String> = Vec::new();
    for sync in syncs(connector) {
        if let Some(entity) = sync["internalEntity"].as_str()
            && !entity_types.iter().any(|e| e == entity)
        {
            entity_types.push(entity.to_owned());
        }
    }
    for entity_type in entity_types {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from integration_field_mappings where connection_id = $1 and entity_type = $2 limit 1",
        )
        .bind(connection_id)
        .bind(&entity_type)
        .fetch_optional(db)
        .await?;
        if existing.is_some() {
            continue;
        }
        let defaults = crate::catalog::default_field_mappings(&entity_type, Some(provider));
        if defaults.is_empty() {
            continue;
        }
        let mut ids = Vec::new();
        let mut external = Vec::new();
        let mut internal = Vec::new();
        let mut directions = Vec::new();
        let mut transforms = Vec::new();
        let mut configs = Vec::new();
        let mut required = Vec::new();
        let mut positions = Vec::new();
        for (i, m) in defaults.iter().enumerate() {
            ids.push(weldsuite_kit::generate_id("ifm"));
            external.push(
                m["externalFieldPath"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            );
            internal.push(
                m["internalFieldPath"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            );
            directions.push(
                m["direction"]
                    .as_str()
                    .unwrap_or("bidirectional")
                    .to_owned(),
            );
            transforms.push(m["transformType"].as_str().unwrap_or("direct").to_owned());
            configs.push(match m.get("transformConfig") {
                None | Some(Value::Null) => Value::Null,
                Some(v) => v.clone(),
            });
            required.push(m["isRequired"].as_bool().unwrap_or(false));
            positions.push(i32::try_from(i).unwrap_or(i32::MAX));
        }
        sqlx::query(
            "insert into integration_field_mappings (id, connection_id, entity_type, external_field_path,
               internal_field_path, direction, transform_type, transform_config, is_required, is_default, position)
             select t.id, $1, $2, t.external, t.internal, t.direction, t.transform,
               case when jsonb_typeof(t.config) = 'null' then null else t.config end, t.required, true, t.position
             from unnest($3::varchar[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[], $9::bool[], $10::int[])
               as t(id, external, internal, direction, transform, config, required, position)",
        )
        .bind(connection_id)
        .bind(&entity_type)
        .bind(&ids)
        .bind(&external)
        .bind(&internal)
        .bind(&directions)
        .bind(&transforms)
        .bind(&configs)
        .bind(&required)
        .bind(&positions)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `markConnectionDisconnected(db, id)`: soft-deleted, credentials and
/// webhooks dropped, its sales channels disconnected.
pub async fn mark_connection_disconnected(
    db: &PgPool,
    connection_id: &str,
) -> Result<(), sqlx::Error> {
    let now = crate::js::now_iso();
    sqlx::query(
        "update connector_connections set deleted_at = $1::timestamp, disconnected_at = $1::timestamp,
           status = 'paused', credentials = null, webhook_secret = null, webhook_registrations = null,
           updated_at = $1::timestamp
         where id = $2",
    )
    .bind(&now)
    .bind(connection_id)
    .execute(db)
    .await?;
    sqlx::query(
        "update product_sales_channels set status = 'disconnected', updated_at = $1::timestamp
         where connection_id = $2",
    )
    .bind(&now)
    .bind(connection_id)
    .execute(db)
    .await?;
    Ok(())
}
