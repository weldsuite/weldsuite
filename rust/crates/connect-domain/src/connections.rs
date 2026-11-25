//! `connectors/connections.ts`: connector connections
//! (`connector_connections`), their stored credentials (each value sealed
//! with the workspace keyring), the shape the client sees, sync runs and the
//! records a connection imported.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, js_row, orm, utc_now};
use weldsuite_schema::tenant::{
    bank_accounts, bank_transactions, bills, companies, connector_connections as connections,
    connector_sync_runs, integration_entity_mappings as mappings, integration_field_mappings,
    invoices, orders, parties, people, product_sales_channels, products,
};

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

/// A model that would not serialize, as the database's error.
#[allow(clippy::needless_pass_by_value, reason = "a `map_err` target")]
pub(crate) fn json_error(error: serde_json::Error) -> DbErr {
    DbErr::Json(error.to_string())
}

/// A `connector_connections` row as `to_jsonb(c)` gave it, which the
/// connection's readers expect: the columns' `snake_case` names (the
/// timestamps as `toISOString()`, which [`js_row`] keeps as they are).
pub(crate) fn connection_row(model: connections::Model) -> Result<Value, DbErr> {
    let Value::Object(columns) = serde_json::to_value(model).map_err(json_error)? else {
        return Ok(Value::Null);
    };
    let mut row = Map::with_capacity(columns.len());
    for (key, value) in columns {
        let mut column = String::with_capacity(key.len() + 4);
        for c in key.chars() {
            if c.is_ascii_uppercase() {
                column.push('_');
                column.push(c.to_ascii_lowercase());
            } else {
                column.push(c);
            }
        }
        row.insert(column, value);
    }
    Ok(Value::Object(row))
}

/// `getConnectionById(db, id)`: the row (`to_jsonb`, `snake_case`), not deleted.
pub async fn get_connection(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    connections::Entity::find()
        .filter(connections::Column::Id.eq(id))
        .filter(connections::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(connection_row)
        .transpose()
}

/// `listConnections(db)`: newest first.
pub async fn list_connections(db: &PgPool) -> Result<Vec<Value>, DbErr> {
    connections::Entity::find()
        .filter(connections::Column::DeletedAt.is_null())
        .order_by_desc(connections::Column::CreatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(connection_row)
        .collect()
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
) -> Result<Vec<Value>, DbErr> {
    connector_sync_runs::Entity::find()
        .filter(connector_sync_runs::Column::ConnectionId.eq(connection_id))
        .order_by_desc(connector_sync_runs::Column::CreatedAt)
        .limit(u64::try_from(limit.min(100)).unwrap_or(0))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|run| serde_json::to_value(run).map_err(json_error))
        .collect()
}

/// `nullif(btrim(text), '')`: Postgres trims spaces only.
fn spaced(text: Option<&str>) -> Option<&str> {
    text.map(|t| t.trim_matches(' ')).filter(|t| !t.is_empty())
}

/// `coalesce(nullif(a, ''), nullif(b, ''), …)`.
fn first_set(texts: &[Option<String>]) -> Option<String> {
    texts.iter().flatten().find(|t| !t.is_empty()).cloned()
}

/// The label of each record of one internal type among `ids`, as
/// `listConnectionRecords` reads it from its table: (id, label).
async fn record_labels(
    db: &PgPool,
    kind: &str,
    ids: Vec<String>,
) -> Result<Vec<(String, Option<String>)>, DbErr> {
    let db = &orm(db);
    Ok(match kind {
        "party" => {
            parties::Entity::find()
                .select_only()
                .columns([parties::Column::Id, parties::Column::DisplayName])
                .filter(parties::Column::Id.is_in(ids))
                .into_tuple()
                .all(db)
                .await?
        }
        "product" => products::Entity::find()
            .select_only()
            .columns([products::Column::Id, products::Column::Name])
            .filter(products::Column::Id.is_in(ids))
            .into_tuple::<(String, String)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, name)| (id, Some(name)))
            .collect(),
        "person" => people::Entity::find()
            .select_only()
            .columns([
                people::Column::Id,
                people::Column::FullName,
                people::Column::FirstName,
                people::Column::LastName,
            ])
            .filter(people::Column::Id.is_in(ids))
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, full, first, last)| {
                // `coalesce(nullif(btrim(full_name), ''), nullif(concat_ws(' ',
                // nullif(first_name, ''), nullif(last_name, '')), ''))`.
                let label = spaced(full.as_deref()).map(str::to_owned).or_else(|| {
                    let joined = [first, last]
                        .into_iter()
                        .flatten()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ");
                    (!joined.is_empty()).then_some(joined)
                });
                (id, label)
            })
            .collect(),
        "company" => companies::Entity::find()
            .select_only()
            .columns([companies::Column::Id, companies::Column::DisplayName])
            .filter(companies::Column::Id.is_in(ids))
            .into_tuple::<(String, String)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, name)| (id, Some(name)))
            .collect(),
        "invoice" => invoices::Entity::find()
            .select_only()
            .columns([
                invoices::Column::Id,
                invoices::Column::InvoiceNumber,
                invoices::Column::ContactName,
                invoices::Column::Reference,
            ])
            .filter(invoices::Column::Id.is_in(ids))
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, number, contact, reference)| (id, first_set(&[number, contact, reference])))
            .collect(),
        "bill" => bills::Entity::find()
            .select_only()
            .columns([
                bills::Column::Id,
                bills::Column::BillNumber,
                bills::Column::ContactName,
                bills::Column::Reference,
            ])
            .filter(bills::Column::Id.is_in(ids))
            .into_tuple::<(String, Option<String>, Option<String>, Option<String>)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, number, contact, reference)| (id, first_set(&[number, contact, reference])))
            .collect(),
        "order" => orders::Entity::find()
            .select_only()
            .columns([orders::Column::Id, orders::Column::OrderNumber])
            .filter(orders::Column::Id.is_in(ids))
            .into_tuple::<(String, String)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, number)| (id, Some(number)))
            .collect(),
        "bank_account" => bank_accounts::Entity::find()
            .select_only()
            .columns([bank_accounts::Column::Id, bank_accounts::Column::Name])
            .filter(bank_accounts::Column::Id.is_in(ids))
            .into_tuple::<(String, String)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, name)| (id, Some(name)))
            .collect(),
        _ => bank_transactions::Entity::find()
            .filter(bank_transactions::Column::Id.is_in(ids))
            .all(db)
            .await?
            .into_iter()
            .map(|row| {
                // `coalesce(nullif(description, ''), nullif(reference, ''),
                // amount::text)`: the amount as Postgres prints `numeric(18, 2)`.
                let amount = Some(row.amount.with_scale(2).to_plain_string());
                (row.id, first_set(&[row.description, row.reference, amount]))
            })
            .collect(),
    })
}

/// `listConnectionRecords(db, connectionId, limit)`: the latest entity
/// mappings with a label read from the record each points at.
pub async fn list_connection_records(
    db: &PgPool,
    connection_id: &str,
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    let mappings: Vec<Value> = mappings::Entity::find()
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        // Moneybird's two-way bookkeeping rows (baselines, payments, pushed
        // bills) are not records the connection imported.
        .filter(mappings::Column::ExternalEntityType.not_like("moneybird\\_baseline\\_%"))
        .filter(
            mappings::Column::ExternalEntityType
                .is_not_in(["moneybird_payment", "moneybird_pushed_bill"]),
        )
        .order_by_desc(mappings::Column::UpdatedAt)
        .limit(u64::try_from(limit.min(100)).unwrap_or(0))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|mapping| serde_json::to_value(mapping).map_err(json_error))
        .collect::<Result<_, _>>()?;
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
    let kinds = [
        "party",
        "product",
        "person",
        "company",
        "invoice",
        "bill",
        "order",
        "bank_account",
        "bank_transaction",
    ];
    let mut labels: Vec<(String, String, String)> = Vec::new();
    for kind in kinds {
        let ids = ids_for(kind);
        if ids.is_empty() {
            continue;
        }
        for (id, label) in record_labels(db, kind, ids).await? {
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
) -> Result<Option<Value>, DbErr> {
    connections::Entity::find()
        .filter(connections::Column::Provider.eq(provider))
        .filter(connections::Column::ExternalAccountId.eq(external_account_id))
        .one(&orm(db))
        .await?
        .map(connection_row)
        .transpose()
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
pub async fn upsert_connection(db: &PgPool, new: &NewConnection<'_>) -> Result<Value, DbErr> {
    let now = utc_now();
    let existing = match new.external_account_id {
        Some(account) => find_by_provider_account(db, new.provider, account).await?,
        None => None,
    };
    let id = if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let mut revived = connections::ActiveModel {
            display_name: Set(Some(new.display_name.to_owned())),
            credentials: Set(Some(Value::Object(new.credentials.clone()))),
            enabled_syncs: Set(Some(json!(new.enabled_syncs))),
            external_account_id: Set(new.external_account_id.map(str::to_owned)),
            status: Set("active".to_owned()),
            deleted_at: Set(None),
            disconnected_at: Set(None),
            last_error: Set(None),
            last_error_at: Set(None),
            connected_at: Set(Some(now)),
            connected_by: Set(Some(new.user_id.to_owned())),
            updated_at: Set(now),
            ..Default::default()
        };
        // `webhook_secret = coalesce($5, webhook_secret)`.
        if let Some(secret) = new.webhook_secret {
            revived.webhook_secret = Set(Some(secret.to_owned()));
        }
        connections::Entity::update_many()
            .set(revived)
            .filter(connections::Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        id
    } else {
        let id = weldsuite_kit::generate_id("conn");
        connections::Entity::insert(connections::ActiveModel {
            id: Set(id.clone()),
            provider: Set(new.provider.to_owned()),
            display_name: Set(Some(new.display_name.to_owned())),
            credentials: Set(Some(Value::Object(new.credentials.clone()))),
            enabled_syncs: Set(Some(json!(new.enabled_syncs))),
            external_account_id: Set(new.external_account_id.map(str::to_owned)),
            webhook_secret: Set(new.webhook_secret.map(str::to_owned)),
            status: Set("active".to_owned()),
            connected_at: Set(Some(now)),
            connected_by: Set(Some(new.user_id.to_owned())),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
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
) -> Result<Value, DbErr> {
    let id = if let Some(existing) =
        find_by_provider_account(db, provider, external_account_id).await?
    {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        let revive = !existing["deleted_at"].is_null() || existing["status"] == "pending";
        let mut revived = connections::ActiveModel {
            display_name: Set(Some(display_name.to_owned())),
            enabled_syncs: Set(Some(json!(enabled_syncs))),
            external_account_id: Set(Some(external_account_id.to_owned())),
            deleted_at: Set(None),
            disconnected_at: Set(None),
            updated_at: Set(utc_now()),
            ..Default::default()
        };
        // `status = case when $4 then 'pending' else status end`, and
        // `connected_by` likewise.
        if revive {
            revived.status = Set("pending".to_owned());
            revived.connected_by = Set(Some(user_id.to_owned()));
        }
        connections::Entity::update_many()
            .set(revived)
            .filter(connections::Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        id
    } else {
        let id = weldsuite_kit::generate_id("conn");
        connections::Entity::insert(connections::ActiveModel {
            id: Set(id.clone()),
            provider: Set(provider.to_owned()),
            display_name: Set(Some(display_name.to_owned())),
            enabled_syncs: Set(Some(json!(enabled_syncs))),
            external_account_id: Set(Some(external_account_id.to_owned())),
            status: Set("pending".to_owned()),
            connected_by: Set(Some(user_id.to_owned())),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
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
) -> Result<(), DbErr> {
    // `col = case when $set then $value else col end`: only what was sent.
    let mut changes = connections::ActiveModel {
        last_error: Set(None),
        last_error_at: Set(None),
        status: Set("active".to_owned()),
        updated_at: Set(utc_now()),
        ..Default::default()
    };
    if let Some(settings) = &update.settings {
        changes.settings = Set(Some(settings.clone()).filter(|v| !v.is_null()));
    }
    if let Some(syncs) = &update.enabled_syncs {
        changes.enabled_syncs = Set(Some(json!(syncs)));
    }
    if let Some(direction) = &update.direction {
        changes.direction = Set(direction.clone());
    }
    if let Some(directions) = &update.object_sync_directions {
        changes.object_sync_directions = Set(Some(directions.clone()).filter(|v| !v.is_null()));
    }
    if let Some(credentials) = &update.credentials {
        changes.credentials = Set(Some(Value::Object(credentials.clone())));
    }
    if let Some(name) = &update.display_name {
        changes.display_name = Set(Some(name.clone()));
    }
    if let Some(account) = &update.external_account_id {
        changes.external_account_id = Set(account.clone());
    }
    if let Some(secret) = &update.webhook_secret {
        changes.webhook_secret = Set(secret.clone());
    }
    if let Some(registrations) = &update.webhook_registrations {
        changes.webhook_registrations = Set(Some(registrations.clone()).filter(|v| !v.is_null()));
    }
    connections::Entity::update_many()
        .set(changes)
        .filter(connections::Column::Id.eq(connection_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

/// `seedDefaultConnectorFieldMappings(db, connectionId, provider)`: the
/// default mappings of every entity type the connector syncs that has none.
pub async fn seed_default_field_mappings(
    db: &PgPool,
    connection_id: &str,
    provider: &str,
) -> Result<(), DbErr> {
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
    let db = &orm(db);
    for entity_type in entity_types {
        let existing: Option<String> = integration_field_mappings::Entity::find()
            .select_only()
            .column(integration_field_mappings::Column::Id)
            .filter(integration_field_mappings::Column::ConnectionId.eq(connection_id))
            .filter(integration_field_mappings::Column::EntityType.eq(entity_type.as_str()))
            .into_tuple()
            .one(db)
            .await?;
        if existing.is_some() {
            continue;
        }
        let defaults = crate::catalog::default_field_mappings(&entity_type, Some(provider));
        if defaults.is_empty() {
            continue;
        }
        let rows = defaults.iter().enumerate().map(|(i, m)| {
            let text = |key: &str, fallback: &str| m[key].as_str().unwrap_or(fallback).to_owned();
            integration_field_mappings::ActiveModel {
                id: Set(weldsuite_kit::generate_id("ifm")),
                connection_id: Set(connection_id.to_owned()),
                entity_type: Set(entity_type.clone()),
                external_field_path: Set(text("externalFieldPath", "")),
                internal_field_path: Set(text("internalFieldPath", "")),
                direction: Set(text("direction", "bidirectional")),
                transform_type: Set(text("transformType", "direct")),
                // A JSON `null` config is stored as NULL.
                transform_config: Set(match m.get("transformConfig") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.clone()),
                }),
                is_required: Set(m["isRequired"].as_bool().unwrap_or(false)),
                is_default: Set(true),
                position: Set(i32::try_from(i).unwrap_or(i32::MAX)),
                ..Default::default()
            }
        });
        integration_field_mappings::Entity::insert_many(rows)
            .exec_without_returning(db)
            .await?;
    }
    Ok(())
}

/// `markConnectionDisconnected(db, id)`: soft-deleted, credentials and
/// webhooks dropped, its sales channels disconnected.
pub async fn mark_connection_disconnected(db: &PgPool, connection_id: &str) -> Result<(), DbErr> {
    let now = utc_now();
    let db = &orm(db);
    connections::Entity::update_many()
        .set(connections::ActiveModel {
            deleted_at: Set(Some(now)),
            disconnected_at: Set(Some(now)),
            status: Set("paused".to_owned()),
            credentials: Set(None),
            webhook_secret: Set(None),
            webhook_registrations: Set(None),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(connections::Column::Id.eq(connection_id))
        .exec(db)
        .await?;
    product_sales_channels::Entity::update_many()
        .col_expr(
            product_sales_channels::Column::Status,
            Expr::value("disconnected"),
        )
        .col_expr(product_sales_channels::Column::UpdatedAt, Expr::value(now))
        .filter(product_sales_channels::Column::ConnectionId.eq(connection_id))
        .exec(db)
        .await?;
    Ok(())
}
