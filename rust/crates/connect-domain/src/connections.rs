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
