//! The generic record steps (`data.ts`): `create_record`, `update_record`,
//! `delete_record` and `query_data` over the tables
//! `engine/entity-tables.ts` maps an entity type to (the generated
//! [`tables`], `tools/entity-tables.mts`).
//!
//! A step's `data` is written the way Drizzle writes it: only the table's
//! properties reach the statement, a column the object leaves out keeps its
//! database default (insert) or its value (update), and a `date`-mode
//! timestamp given anything but a `Date` throws before the statement runs
//! (`value.toISOString is not a function`). Rows come back as Drizzle
//! returns them, without the sensitive columns (`selectableColumns`), and
//! the mail tables only show and change shared mailboxes (MAIL-003).
//!
//! `assertMailMessageStoreIsPostgres` always passes here: the mailbox store
//! is `postgres` on Kubernetes (MAIL-010). Tickets (`ticket`,
//! `helpdesk_ticket`) open a WeldDesk inbox conversation on Global, which
//! the Rust backend can't yet (see `helpdesk::create_conversation`).

mod tables;

use serde_json::{Map, Value, json};
use weldsuite_db::js_timestamp;

use super::{ActionCtx, ActionError, ActionResult};
use crate::engine::template::strict_equals;
use crate::js::{as_text, js_number, js_string, truthy};

/// How Drizzle maps a property's value onto its column.
#[allow(dead_code)] // every Drizzle kind the generator writes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Text,
    Number,
    Bool,
    Json,
    /// `timestamp` / `date` in `date` mode: a `Date` both ways.
    Date,
    /// `timestamp` / `date` in `string` mode.
    DateString,
    /// `numeric`: read back as a string.
    Numeric,
    Array,
    Other,
}

/// A table property.
#[derive(Debug, Clone, Copy)]
pub(super) struct Column {
    /// The Drizzle property (`accountId`).
    pub(super) prop: &'static str,
    /// The column (`account_id`).
    pub(super) name: &'static str,
    pub(super) kind: Kind,
    /// Not a sensitive column (`selectableColumns` keeps it).
    pub(super) selectable: bool,
}

/// A table the record steps reach, with the statements they run.
#[derive(Debug, Clone, Copy)]
pub(super) struct EntityTable {
    #[allow(dead_code)] // the generator names every table
    pub(super) name: &'static str,
    pub(super) columns: &'static [Column],
    /// `$1`: the row as `{ column: value }`. Returns the row.
    pub(super) insert: &'static str,
    /// `$1`: the changes as `{ column: value }`, `$2`: the id. Returns the
    /// changed row.
    pub(super) patch: &'static str,
    /// `$1`: the id, `$2`: now. `None` when the table has neither
    /// `deleted_at` nor `updated_at`.
    pub(super) soft_delete: Option<&'static str>,
    /// `$1`: the id.
    pub(super) hard_delete: &'static str,
    /// `$1`: limit, `$2`: offset. The live rows; `None` for a table without
    /// `deleted_at`.
    pub(super) query: Option<&'static str>,
}

impl EntityTable {
    fn column(&self, prop: &str) -> Option<&'static Column> {
        self.columns.iter().find(|c| c.prop == prop)
    }

    /// A row (`to_jsonb(t)`) as Drizzle returns `returning(getEntityColumns)`.
    fn js(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        let mut out = Map::with_capacity(self.columns.len());
        for column in self.columns.iter().filter(|c| c.selectable) {
            let value = row.remove(column.name).unwrap_or(Value::Null);
            let value = match (column.kind, value) {
                (Kind::Date, Value::String(text)) => Value::String(js_date(&text)),
                (_, value) => value,
            };
            out.insert(column.prop.to_owned(), value);
        }
        Value::Object(out)
    }

    /// `data` as `{ column: value }`: only the table's properties, and a
    /// `date`-mode timestamp must not come from the step (Drizzle would call
    /// `toISOString` on it). `except` names the properties the step's own
    /// values override.
    fn values(
        &self,
        data: &Map<String, Value>,
        except: &[&str],
    ) -> Result<Map<String, Value>, ActionError> {
        let mut values = Map::new();
        for (prop, value) in data {
            if except.contains(&prop.as_str()) {
                continue;
            }
            let Some(column) = self.column(prop) else {
                continue;
            };
            if column.kind == Kind::Date && !value.is_null() {
                return Err(ActionError::named(
                    "TypeError",
                    "value.toISOString is not a function",
                ));
            }
            values.insert(column.name.to_owned(), value.clone());
        }
        Ok(values)
    }

    fn set(&self, values: &mut Map<String, Value>, prop: &str, value: Value) {
        if let Some(column) = self.column(prop) {
            values.insert(column.name.to_owned(), value);
        }
    }
}

/// A `timestamp` or `date` read in `date` mode, as `toISOString()`.
fn js_date(text: &str) -> String {
    if text.len() == 10 {
        return format!("{text}T00:00:00.000Z");
    }
    js_timestamp(text).unwrap_or_else(|| text.to_owned())
}

fn normalized(entity: &str) -> String {
    entity.to_lowercase().replace('-', "_")
}

/// `getEntityTable(entityType)`.
fn table_of(entity: &str) -> Result<&'static EntityTable, ActionError> {
    let key = normalized(entity);
    tables::ENTITY_TABLES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, table)| *table)
        .ok_or_else(|| {
            let available: Vec<&str> = tables::ENTITY_TABLES.iter().map(|(n, _)| *n).collect();
            ActionError::plain(&format!(
                "Unknown entity type: {entity}. Available: {}",
                available.join(", ")
            ))
        })
}

/// `getEntityIdPrefix(entityType)`.
fn id_prefix(entity: &str) -> String {
    let key = normalized(entity);
    tables::ID_PREFIXES
        .iter()
        .find(|(name, _)| *name == key)
        .map_or_else(|| key.chars().take(3).collect(), |(_, p)| (*p).to_owned())
}

/// `asText(inputs.entity || inputs.entityType || '')`.
fn entity_type(inputs: &Map<String, Value>) -> String {
    first_text(&[inputs.get("entity"), inputs.get("entityType")])
}

fn first_text(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .flatten()
        .find(|v| truthy(v))
        .map_or_else(String::new, |v| as_text(Some(v)))
}

/// `(inputs.data || inputs.fields || {})`: an object's own keys (a string
/// or an array spreads only indexes, which no table has).
fn data_of(inputs: &Map<String, Value>, keys: [&str; 2]) -> Map<String, Value> {
    match keys
        .iter()
        .filter_map(|k| inputs.get(*k))
        .find(|v| truthy(v))
    {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn db_error(error: &sqlx::Error) -> ActionError {
    ActionError::plain(&error.to_string())
}

// ── Mail entities (MAIL-003) ────────────────────────────────────────────────

/// `MAIL_ENTITY_ACCOUNT_COLUMN`: the property that names a mail row's account.
fn mail_account_column(entity: &str) -> Option<&'static str> {
    match normalized(entity).as_str() {
        "mail_account" => Some("id"),
        "mail_message" | "mail_folder" => Some("accountId"),
        _ => None,
    }
}

/// `SENSITIVE_COLUMNS.mail_accounts`.
const MAIL_ACCOUNT_SENSITIVE: [&str; 5] = [
    "accessToken",
    "refreshToken",
    "apiKey",
    "passwordHash",
    "providerConfig",
];

/// `assertMailEntityWriteData(db, entityType, data, { requireAccountColumn })`.
async fn assert_mail_write(
    ctx: &ActionCtx<'_>,
    entity: &str,
    data: &Map<String, Value>,
    require_account: bool,
) -> Result<(), ActionError> {
    let column = mail_account_column(entity);
    if column == Some("id") {
        let offending: Vec<&str> = MAIL_ACCOUNT_SENSITIVE
            .iter()
            .copied()
            .filter(|key| data.contains_key(*key))
            .collect();
        if !offending.is_empty() {
            return Err(ActionError::plain(&format!(
                "Cannot set {} on mail_account through a generic record action",
                offending.join(", ")
            )));
        }
    }
    let Some(column) = column else {
        return Ok(());
    };
    if column == "id" {
        if data
            .get("isShared")
            .is_some_and(|v| v != &Value::Bool(true))
        {
            return Err(ActionError::plain(
                "A workflow can only write a shared mail account: there is no workspace member to assign a private one to",
            ));
        }
        return Ok(());
    }
    let Some(account) = data.get(column) else {
        if !require_account {
            return Ok(());
        }
        return Err(ActionError::plain(&format!("{entity} requires {column}")));
    };
    let Some(account) = account.as_str().filter(|a| !a.is_empty()) else {
        return Err(ActionError::plain(&format!("{entity} requires {column}")));
    };
    let shared: Option<Option<bool>> = sqlx::query_scalar(
        "select is_shared from mail_accounts where id = $1 and deleted_at is null",
    )
    .bind(account)
    .fetch_optional(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    if shared.flatten() != Some(true) {
        return Err(ActionError::plain(&format!(
            "Mail account {account} is not a shared mailbox; a workflow may only write to shared mailboxes (MAIL-003)"
        )));
    }
    Ok(())
}

// ── The steps ───────────────────────────────────────────────────────────────

/// `TICKET_ENTITIES`.
fn is_ticket(entity: &str) -> bool {
    matches!(normalized(entity).as_str(), "ticket" | "helpdesk_ticket")
}

pub(super) async fn create_record(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let entity = entity_type(inputs);
    let data = data_of(inputs, ["data", "fields"]);
    if entity.is_empty() {
        return Err(ActionError::plain("Entity type is required"));
    }
    if is_ticket(&entity) {
        // `createTicketAsConversation`: a WeldDesk inbox conversation.
        return super::helpdesk::create_conversation(inputs, ctx);
    }
    assert_mail_write(ctx, &entity, &data, true).await?;
    let table = table_of(&entity)?;
    let now = super::now_text();
    // `{ id, ...data, ...mailEntityCreateOverrides, createdAt, updatedAt }`.
    let mut values = Map::new();
    table.set(
        &mut values,
        "id",
        json!(crate::engine::engine_id(&id_prefix(&entity))),
    );
    values.extend(table.values(&data, &["createdAt", "updatedAt"])?);
    if mail_account_column(&entity) == Some("id") {
        table.set(&mut values, "isShared", Value::Bool(true));
    }
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    table.set(&mut values, "workspaceId", json!(ctx.info.workspace_id));
    let row: Value = sqlx::query_scalar(table.insert)
        .bind(Value::Object(values))
        .fetch_one(ctx.db)
        .await
        .map_err(|e| db_error(&e))?;
    Ok(json!({ "created": true, "record": table.js(row) }))
}

pub(super) async fn update_record(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let entity = entity_type(inputs);
    let id = first_text(&[inputs.get("id"), inputs.get("recordId")]);
    let data = data_of(inputs, ["data", "fields"]);
    if entity.is_empty() {
        return Err(ActionError::plain("Entity type is required"));
    }
    if id.is_empty() {
        return Err(ActionError::plain("Record ID is required"));
    }
    assert_mail_write(ctx, &entity, &data, false).await?;
    let table = table_of(&entity)?;
    // `.set({ ...data, updatedAt })`.
    let mut values = table.values(&data, &["updatedAt"])?;
    table.set(&mut values, "updatedAt", json!(super::now_text()));
    let row: Option<Value> = sqlx::query_scalar(table.patch)
        .bind(Value::Object(values))
        .bind(&id)
        .fetch_optional(ctx.db)
        .await
        .map_err(|e| db_error(&e))?;
    let Some(row) = row else {
        return Err(ActionError::plain(&format!("Record {id} not found")));
    };
    Ok(json!({ "updated": true, "record": table.js(row) }))
}

pub(super) async fn delete_record(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let entity = entity_type(inputs);
    let id = first_text(&[inputs.get("id"), inputs.get("recordId")]);
    if entity.is_empty() {
        return Err(ActionError::plain("Entity type is required"));
    }
    if id.is_empty() {
        return Err(ActionError::plain("Record ID is required"));
    }
    let table = table_of(&entity)?;
    if inputs.get("hardDelete") == Some(&Value::Bool(true)) {
        sqlx::query(table.hard_delete)
            .bind(&id)
            .execute(ctx.db)
            .await
            .map_err(|e| db_error(&e))?;
    } else {
        let Some(statement) = table.soft_delete else {
            return Err(ActionError::plain("No values to set"));
        };
        sqlx::query(statement)
            .bind(&id)
            .bind(super::now_text())
            .execute(ctx.db)
            .await
            .map_err(|e| db_error(&e))?;
    }
    Ok(json!({ "deleted": true, "id": id }))
}

/// `String(value)` of a record's field (a `Date` as its ISO time).
fn field_text(value: Option<&Value>) -> String {
    js_string(value)
}

/// `Number(value)` of a record's field; a `date`-mode column is a `Date`,
/// whose number is its epoch milliseconds.
#[allow(clippy::cast_precision_loss)]
fn field_number(value: Option<&Value>, kind: Option<Kind>) -> f64 {
    if kind == Some(Kind::Date)
        && let Some(Value::String(text)) = value
    {
        return time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
            .map_or(f64::NAN, |at| {
                (at.unix_timestamp_nanos() / 1_000_000) as f64
            });
    }
    js_number(value)
}

/// `record[key] === value`: a `Date` field equals nothing.
fn field_equals(value: Option<&Value>, kind: Option<Kind>, wanted: Option<&Value>) -> bool {
    if kind == Some(Kind::Date) && value.is_some_and(|v| !v.is_null()) {
        return false;
    }
    strict_equals(value, wanted)
}

pub(super) async fn query_data(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let entity = entity_type(inputs);
    if entity.is_empty() {
        return Err(ActionError::plain("Entity type is required"));
    }
    let table = table_of(&entity)?;
    let filters = data_of(inputs, ["filters", "where"]);
    let number = |key: &str| {
        let n = js_number(inputs.get(key));
        if n.is_finite() && n != 0.0 {
            Some(n)
        } else {
            None
        }
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = number("limit").map_or(100, |n| n as i64);
    #[allow(clippy::cast_possible_truncation)]
    let offset = number("offset").map_or(0, |n| n as i64);
    let Some(statement) = table.query else {
        // `isNull(table.deletedAt)` on a table without the column renders
        // ` is null`, which the database refuses.
        return Err(ActionError::plain("syntax error at or near \"is\""));
    };
    let rows: Vec<Value> = sqlx::query_scalar(statement)
        .bind(limit)
        .bind(offset)
        .fetch_all(ctx.db)
        .await
        .map_err(|e| db_error(&e))?;
    let mut records: Vec<Value> = rows.into_iter().map(|row| table.js(row)).collect();
    for (key, wanted) in &filters {
        let kind = table.column(key).filter(|c| c.selectable).map(|c| c.kind);
        records.retain(|record| {
            let value = record.get(key);
            match wanted {
                Value::Object(op) => {
                    let operand = op.get("value");
                    match op.get("operator").and_then(Value::as_str) {
                        Some("neq" | "not_equals") => !field_equals(value, kind, operand),
                        Some("contains") => field_text(value).contains(&js_string(operand)),
                        Some("gt") => field_number(value, kind) > js_number(operand),
                        Some("lt") => field_number(value, kind) < js_number(operand),
                        _ => field_equals(value, kind, operand),
                    }
                }
                // An array is an object to `typeof`, without an operator.
                Value::Array(_) => field_equals(value, kind, None),
                other => field_equals(value, kind, Some(other)),
            }
        });
    }
    let count = records.len();
    Ok(json!({ "records": records, "count": count }))
}
