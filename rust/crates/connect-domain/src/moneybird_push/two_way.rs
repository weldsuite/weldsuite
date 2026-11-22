//! The two-way part of the Moneybird push (ADR INT-013): WeldBooks contacts,
//! products, invoices, bills and their payments go to Moneybird for every
//! object whose direction on the connection is `outbound` or
//! `bidirectional`.
//!
//! What changed is read from the database, never from an event. Every
//! synced record has a baseline row in `integration_entity_mappings` on the
//! Moneybird connection: `moneybird_baseline_<object>`, the Moneybird id,
//! `sync_checksum` = the hash of the Moneybird-shaped payload WeldBooks would
//! send, and `last_synced_at` = the row's own change time when it was
//! hashed. The import refreshes it after writing the row
//! ([`refresh_baseline`]); a push writes the baseline of what it sent. A
//! record is pushed only when its hash moved, so an echo of our own push
//! re-baselines on import and never loops.
//!
//! - Records that came from Moneybird (an inbound mapping) are updated in
//!   place; Moneybird's own rules apply (sales invoices change in draft
//!   only). Before an update the record is read back: when Moneybird
//!   changed it too, the newer side wins and an `integration_sync_conflicts`
//!   row records both.
//! - Records made in WeldBooks after the object was switched to outbound
//!   (`settings.moneybirdTwoWay.since`) are created: contacts and products
//!   at once, bills once approved (as purchase invoices), invoices once
//!   sent (as external sales invoices, by the parent module's
//!   `push_invoice`).
//! - Payments allocated to a synced document follow it; a voided payment is
//!   removed.

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};

use super::{
    MB_CONTACT_TYPE, MB_INVOICE_TYPE, Pass, PushError, STALE_CLAIM_MS, STRIPE_INVOICE_TYPE, Step,
    amount_and_price, claim, complete_claim, contact_payload, cutoffs, fail_claim, num,
    release_claim, resolve_contact, resolve_tax_rate_of, tax_rates, text_id, ymd,
};
use crate::connections::{SettingsUpdate, update_connection_settings};
use crate::ingest::record_checksum;
use crate::js::{now_iso, string};
use crate::mappers::{DocumentLine, map_document_lines, slice_units};

/// The objects that can go to Moneybird (bank accounts and lines stay
/// inbound: they come from the bank feed in Moneybird).
pub const OBJECTS: [&str; 4] = ["contacts", "products", "invoices", "bills"];

pub const PRODUCT_TYPE: &str = "moneybird_product";
pub const SALES_INVOICE_TYPE: &str = "moneybird_sales_invoice";
pub const PURCHASE_INVOICE_TYPE: &str = "moneybird_purchase_invoice";
pub const RECEIPT_TYPE: &str = "moneybird_receipt";
/// A WeldBooks payment on a Moneybird document: the external id is
/// `<document id>:<payment id>` (claims: `pending:` / `failed:` and
/// `<document id>:<WeldBooks payment id>`).
pub const PAYMENT_TYPE: &str = "moneybird_payment";
/// Marks a purchase invoice WeldBooks created (its bill came from
/// WeldBooks, not Moneybird).
pub const PUSHED_BILL_TYPE: &str = "moneybird_pushed_bill";
const BASELINE_PREFIX: &str = "moneybird_baseline_";

const MAX_PER_OBJECT: i64 = 25;
const MAX_NEW_BASELINES: i64 = 200;
/// Bill states WeldBooks sends on (approved and later).
const BILL_PUSHABLE: [&str; 4] = ["approved", "partial", "overdue", "paid"];
const SALES_BASES: [(&str, &str); 2] = [
    (SALES_INVOICE_TYPE, "sales_invoices"),
    (MB_INVOICE_TYPE, "external_sales_invoices"),
];
const BILL_BASES: [(&str, &str); 2] = [
    (PURCHASE_INVOICE_TYPE, "documents/purchase_invoices"),
    (RECEIPT_TYPE, "documents/receipts"),
];

// ── directions ──────────────────────────────────────────────────────────────

/// An object's direction: its own, else the connection's, else `inbound`.
pub fn object_direction<'a>(connection: &'a Value, key: &str) -> &'a str {
    connection
        .get("object_sync_directions")
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .or_else(|| {
            connection
                .get("direction")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
        })
        .unwrap_or("inbound")
}

fn object_enabled(connection: &Value, key: &str) -> bool {
    let Some(connector) = crate::catalog::get_connector("moneybird") else {
        return false;
    };
    crate::webhooks::enabled_syncs(connector, connection.get("enabled_syncs"))
        .iter()
        .any(|s| s["settingKey"].as_str() == Some(key))
}

/// Whether WeldBooks sends this object (a [`OBJECTS`] key) to Moneybird.
pub fn is_outbound(connection: &Value, key: &str) -> bool {
    connection["provider"] == "moneybird"
        && OBJECTS.contains(&key)
        && matches!(
            object_direction(connection, key),
            "outbound" | "bidirectional"
        )
        && object_enabled(connection, key)
}

/// The objects this connection sends to Moneybird.
pub fn outbound_objects(connection: &Value) -> Vec<&'static str> {
    OBJECTS
        .into_iter()
        .filter(|key| is_outbound(connection, key))
        .collect()
}

/// When the object was switched to outbound: WeldBooks records made before
/// it are never created in Moneybird.
pub fn since(connection: &Value, key: &str) -> Option<String> {
    connection
        .get("settings")
        .and_then(|s| s.get("moneybirdTwoWay"))
        .and_then(|t| t.get("since"))
        .and_then(|s| s.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The connection's settings with `moneybirdTwoWay.since` in line with its
/// directions: a newly outbound object stamped now, an object back to
/// inbound unstamped (so switching it on again never sends what was made
/// meanwhile). `None`: nothing to change.
pub fn settings_with_since(connection: &Value) -> Option<Value> {
    let mut settings = connection
        .get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut two_way = settings
        .get("moneybirdTwoWay")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut stamps = two_way
        .get("since")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let before = stamps.clone();
    let now = now_iso();
    for key in OBJECTS {
        if is_outbound(connection, key) {
            if stamps
                .get(key)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                stamps.insert(key.to_owned(), json!(now));
            }
        } else {
            stamps.remove(key);
        }
    }
    if stamps == before {
        return None;
    }
    two_way.insert("since".to_owned(), Value::Object(stamps));
    settings.insert("moneybirdTwoWay".to_owned(), Value::Object(two_way));
    Some(Value::Object(settings))
}

/// [`settings_with_since`] saved; the connection as it is now.
pub async fn stamp_since(db: &PgPool, connection: &Value) -> Result<Value, sqlx::Error> {
    let Some(settings) = settings_with_since(connection) else {
        return Ok(connection.clone());
    };
    let id = connection["id"].as_str().unwrap_or_default();
    update_connection_settings(
        db,
        id,
        &SettingsUpdate {
            settings: Some(settings.clone()),
            ..SettingsUpdate::default()
        },
    )
    .await?;
    let mut updated = connection.clone();
    updated["settings"] = settings;
    Ok(updated)
}

// ── baselines ───────────────────────────────────────────────────────────────

/// The baseline row type of an inbound mapping type.
fn baseline_type(inbound: &str) -> Option<String> {
    matches!(
        inbound,
        MB_CONTACT_TYPE | PRODUCT_TYPE | SALES_INVOICE_TYPE | PURCHASE_INVOICE_TYPE | RECEIPT_TYPE
    )
    .then(|| {
        format!(
            "{BASELINE_PREFIX}{}",
            inbound.trim_start_matches("moneybird_")
        )
    })
}

/// Mapping rows that record the push's own state, not a synced record
/// (hidden from the connection's records list).
pub fn is_bookkeeping_type(kind: &str) -> bool {
    kind.starts_with(BASELINE_PREFIX) || kind == PAYMENT_TYPE || kind == PUSHED_BILL_TYPE
}

fn internal_type(inbound: &str) -> &'static str {
    match inbound {
        MB_CONTACT_TYPE => "party",
        PRODUCT_TYPE => "product",
        SALES_INVOICE_TYPE => "invoice",
        _ => "bill",
    }
}

/// A record's hash and its change time (`YYYY-MM-DD HH:MM:SS.US`, as the
/// database stores it), as one baseline holds them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Hashed {
    hash: String,
    changed_at: String,
}

async fn write_baseline(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    external_id: &str,
    internal_id: &str,
    hashed: &Hashed,
) -> Result<(), sqlx::Error> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    sqlx::query(
        "insert into integration_entity_mappings (id, created_at, updated_at, connection_id,
           external_entity_type, external_entity_id, internal_entity_type, internal_entity_id,
           last_synced_at, sync_checksum)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8::timestamp, $9)
         on conflict (connection_id, external_entity_type, external_entity_id) do update set
           internal_entity_id = excluded.internal_entity_id, sync_checksum = excluded.sync_checksum,
           last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at",
    )
    .bind(weldsuite_kit::generate_id("iem"))
    .bind(now_iso())
    .bind(connection_id)
    .bind(kind)
    .bind(external_id)
    .bind(internal_type(inbound))
    .bind(internal_id)
    .bind(&hashed.changed_at)
    .bind(&hashed.hash)
    .execute(db)
    .await
    .map(|_| ())
}

/// Forgets a record's baseline: it is gone on one side.
pub async fn drop_baseline(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    external_id: &str,
) -> Result<(), sqlx::Error> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    sqlx::query(
        "delete from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3",
    )
    .bind(connection_id)
    .bind(kind)
    .bind(external_id)
    .execute(db)
    .await
    .map(|_| ())
}

/// The import's hook: the record as WeldBooks has it now is what Moneybird
/// has, so it is the baseline. Called after the import wrote the row.
pub async fn refresh_baseline(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    external_id: &str,
    internal_id: &str,
) -> Result<(), sqlx::Error> {
    if baseline_type(inbound).is_none() {
        return Ok(());
    }
    let Some(hashed) = hash_of(db, inbound, internal_id).await? else {
        return Ok(());
    };
    write_baseline(
        db,
        connection_id,
        inbound,
        external_id,
        internal_id,
        &hashed,
    )
    .await
}

async fn hash_of(
    db: &PgPool,
    inbound: &str,
    internal_id: &str,
) -> Result<Option<Hashed>, sqlx::Error> {
    Ok(match inbound {
        MB_CONTACT_TYPE => contact_state(db, internal_id).await?.map(|s| s.hashed()),
        PRODUCT_TYPE => product_state(db, internal_id).await?.map(|s| s.hashed()),
        SALES_INVOICE_TYPE => doc_state(db, true, internal_id).await?.map(|s| s.hashed()),
        PURCHASE_INVOICE_TYPE | RECEIPT_TYPE => {
            doc_state(db, false, internal_id).await?.map(|s| s.hashed())
        }
        _ => None,
    })
}

/// Whether a create of this type is in flight on the connection: a Moneybird
/// create delivery for a record not mapped yet may be our own, arriving
/// before its mapping is written, so it is retried later rather than
/// imported as a duplicate.
pub async fn create_in_flight(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
) -> Result<bool, sqlx::Error> {
    let cutoff =
        weldsuite_kit::validation::js_iso_from_millis(crate::js::now_ms() - STALE_CLAIM_MS)
            .unwrap_or_default();
    let found: Option<i32> = sqlx::query_scalar(
        "select 1 from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2
           and external_entity_id like 'pending:%' and updated_at > $3::timestamp limit 1",
    )
    .bind(connection_id)
    .bind(inbound)
    .bind(cutoff)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

// ── the WeldBooks side, as Moneybird would get it ───────────────────────────

/// The `to_char` format that keeps a timestamp's microseconds.
const STAMP: &str = "YYYY-MM-DD HH24:MI:SS.US";

/// A database stamp (`YYYY-MM-DD HH:MM:SS.ffffff` or with a `T`, UTC) in
/// milliseconds.
fn stamp_millis(stamp: &str) -> f64 {
    let millis: String = stamp.trim().chars().take(23).collect();
    crate::mappers::js_date_loose(&format!("{}Z", millis.replacen(' ', "T", 1))).unwrap_or(0.0)
}

struct ContactState {
    create: Value,
    update: Value,
    archived: bool,
    deleted: bool,
    changed_at: String,
}

/// The contact fields an update sends, cleared ones as empty strings so a
/// field removed in WeldBooks is removed in Moneybird too.
const CONTACT_FIELDS: [&str; 8] = [
    "send_invoices_to_email",
    "phone",
    "tax_number",
    "address1",
    "address2",
    "zipcode",
    "city",
    "country",
];

impl ContactState {
    fn hashed(&self) -> Hashed {
        Hashed {
            hash: record_checksum(&json!({ "contact": self.update, "archived": self.archived })),
            changed_at: self.changed_at.clone(),
        }
    }
}

async fn contact_state(db: &PgPool, party_id: &str) -> Result<Option<ContactState>, sqlx::Error> {
    let flags: Option<(bool, bool, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select p.deleted_at is not null, p.archived_at is not null,
           to_char(greatest(p.updated_at, p.deleted_at, p.archived_at, c.updated_at, pe.updated_at), '{STAMP}')
         from parties p left join companies c on c.id = p.company_id left join people pe on pe.id = p.person_id
         where p.id = $1 limit 1"
    )))
    .bind(party_id)
    .fetch_optional(db)
    .await?;
    let Some((deleted, archived, changed_at)) = flags else {
        return Ok(None);
    };
    let Some((_, create)) = contact_payload(db, party_id).await? else {
        return Ok(None);
    };
    let mut update = create.as_object().cloned().unwrap_or_default();
    update.remove("email");
    for key in CONTACT_FIELDS {
        update.entry(key.to_owned()).or_insert_with(|| json!(""));
    }
    Ok(Some(ContactState {
        create,
        update: Value::Object(update),
        archived,
        deleted,
        changed_at,
    }))
}

struct ProductState {
    body: Value,
    deleted: bool,
    changed_at: String,
    vat_category: String,
    taxable: bool,
}

impl ProductState {
    fn hashed(&self) -> Hashed {
        Hashed {
            hash: record_checksum(&self.body),
            changed_at: self.changed_at.clone(),
        }
    }
}

async fn product_state(db: &PgPool, id: &str) -> Result<Option<ProductState>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select jsonb_build_object('name', p.name, 'description', p.description, 'sku', p.sku,
           'price', p.price::text, 'currency', p.currency, 'deleted', p.deleted_at is not null,
           'changedAt', to_char(greatest(p.updated_at, p.deleted_at), '{STAMP}'),
           'vatCategory', p.vat_category, 'taxable', coalesce(p.taxable, true))
         from products p where p.id = $1 limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let name = string(row.get("name")).unwrap_or_default().to_owned();
    let mut body = Map::new();
    body.insert("title".to_owned(), json!(slice_units(&name, 255)));
    let description = string(row.get("description"))
        .filter(|d| !d.trim().is_empty())
        .unwrap_or(name.as_str());
    body.insert(
        "description".to_owned(),
        json!(slice_units(description, 4096)),
    );
    if let Some(sku) = string(row.get("sku")).filter(|s| !s.trim().is_empty()) {
        body.insert("identifier".to_owned(), json!(sku.trim()));
    }
    body.insert(
        "price".to_owned(),
        json!(crate::js::to_fixed(
            string(row.get("price")).map_or(0.0, num),
            2
        )),
    );
    body.insert(
        "currency".to_owned(),
        json!(
            string(row.get("currency"))
                .filter(|c| !c.is_empty())
                .unwrap_or("EUR")
                .to_uppercase()
        ),
    );
    Ok(Some(ProductState {
        body: Value::Object(body),
        deleted: row["deleted"].as_bool().unwrap_or(false),
        changed_at: string(row.get("changedAt")).unwrap_or_default().to_owned(),
        vat_category: string(row.get("vatCategory"))
            .unwrap_or("standard")
            .to_owned(),
        taxable: row["taxable"].as_bool().unwrap_or(true),
    }))
}

/// One document line as both sides are compared: description, quantity,
/// unit price excluding VAT, VAT percentage.
#[derive(Debug, Clone, PartialEq)]
struct Line {
    description: String,
    quantity: String,
    unit_price: String,
    tax_rate: Option<String>,
    total: Option<String>,
    period: Option<Value>,
}

impl Line {
    fn key(&self) -> Value {
        json!([
            self.description.trim(),
            crate::js::number_text(num(&self.quantity)),
            crate::js::to_fixed(num(&self.unit_price), 2),
            self.tax_rate
                .as_deref()
                .map(|r| crate::js::to_fixed(num(r), 2)),
        ])
    }

    fn from_document(line: &DocumentLine) -> Self {
        Self {
            description: line.description.clone(),
            quantity: line.quantity.clone(),
            unit_price: line.unit_price.clone(),
            tax_rate: line.tax_rate.clone(),
            total: line.line_total.clone(),
            period: None,
        }
    }
}

fn line_keys(lines: &[Line]) -> Vec<Value> {
    lines.iter().map(Line::key).collect()
}

struct DocState {
    invoice: bool,
    row: Value,
    lines: Vec<Line>,
    deleted: bool,
    changed_at: String,
}

impl DocState {
    /// `draft` (a finalized invoice is booked but not sent yet), `open` (sent
    /// and later, paid included: payments travel on their own),
    /// `uncollectible` or `cancelled`.
    fn status_class(&self) -> &'static str {
        match string(self.row.get("status")).unwrap_or_default() {
            "draft" => "draft",
            "finalized" if self.invoice => "draft",
            "cancelled" => "cancelled",
            "uncollectible" if self.invoice => "uncollectible",
            _ => "open",
        }
    }

    fn party(&self) -> String {
        string(self.row.get("counterpartyId"))
            .filter(|p| !p.is_empty())
            .or_else(|| string(self.row.get("contactId")))
            .unwrap_or_default()
            .to_owned()
    }

    fn reference(&self) -> String {
        let keys: &[&str] = if self.invoice {
            &["reference", "invoiceNumber"]
        } else {
            &["externalReference", "reference", "billNumber"]
        };
        keys.iter()
            .find_map(|k| string(self.row.get(*k)).filter(|s| !s.trim().is_empty()))
            .map_or_else(
                || self.row["id"].as_str().unwrap_or_default().to_owned(),
                |s| slice_units(s.trim(), 255),
            )
    }

    fn currency(&self) -> String {
        string(self.row.get("currency"))
            .filter(|c| !c.is_empty())
            .unwrap_or("EUR")
            .to_uppercase()
    }

    fn hashed(&self) -> Hashed {
        Hashed {
            hash: record_checksum(&json!({
                "contact": self.party(),
                "reference": self.reference(),
                "date": ymd(string(self.row.get("issueDate"))),
                "due": ymd(string(self.row.get("dueDate"))),
                "currency": self.currency(),
                "status": self.status_class(),
                "lines": line_keys(&self.lines),
            })),
            changed_at: self.changed_at.clone(),
        }
    }
}

async fn doc_state(db: &PgPool, invoice: bool, id: &str) -> Result<Option<DocState>, sqlx::Error> {
    let (table, items, parent) = if invoice {
        ("invoices", "invoice_items", "invoice_id")
    } else {
        ("bills", "bill_items", "bill_id")
    };
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) || jsonb_build_object('total', t.total::text,
           'changedStamp', to_char(greatest(t.updated_at, t.deleted_at), '{STAMP}'))
         from {table} t where t.id = $1 limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(js_row) else {
        return Ok(None);
    };
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) || jsonb_build_object('quantity', t.quantity::text, 'unit_price', t.unit_price::text,
           'line_total', t.line_total::text, 'tax_rate', t.tax_rate::text)
         from {items} t where t.{parent} = $1 and t.deleted_at is null order by t.sort_order asc"
    )))
    .bind(id)
    .fetch_all(db)
    .await?;
    let lines = rows
        .into_iter()
        .map(js_row)
        .map(|item| Line {
            description: string(item.get("description"))
                .unwrap_or_default()
                .to_owned(),
            quantity: string(item.get("quantity")).unwrap_or("1").to_owned(),
            unit_price: string(item.get("unitPrice")).unwrap_or("0").to_owned(),
            tax_rate: string(item.get("taxRate"))
                .filter(|r| !r.is_empty())
                .map(str::to_owned),
            total: string(item.get("lineTotal")).map(str::to_owned),
            period: item.get("period").filter(|p| !p.is_null()).cloned(),
        })
        .collect();
    Ok(Some(DocState {
        invoice,
        deleted: !row["deletedAt"].is_null(),
        changed_at: string(row.get("changedStamp"))
            .unwrap_or_default()
            .to_owned(),
        row,
        lines,
    }))
}

// ── candidates ──────────────────────────────────────────────────────────────

/// A synced record whose WeldBooks row changed since its baseline.
struct Candidate {
    external_id: String,
    internal_id: String,
    /// The import's checksum of the Moneybird record.
    inbound_checksum: Option<String>,
    /// When the import or the push last saw it.
    inbound_synced_at: Option<String>,
    baseline: String,
}

/// How a mapped record of this type is read: its table (as `t`), the joins
/// its change time needs, and that change time.
fn changed_sql(inbound: &str) -> (&'static str, &'static str, &'static str) {
    match inbound {
        MB_CONTACT_TYPE => (
            "parties t",
            "left join companies c on c.id = t.company_id left join people pe on pe.id = t.person_id",
            "greatest(t.updated_at, t.deleted_at, t.archived_at, c.updated_at, pe.updated_at)",
        ),
        PRODUCT_TYPE => ("products t", "", "greatest(t.updated_at, t.deleted_at)"),
        SALES_INVOICE_TYPE => ("invoices t", "", "greatest(t.updated_at, t.deleted_at)"),
        _ => ("bills t", "", "greatest(t.updated_at, t.deleted_at)"),
    }
}

async fn changed_candidates(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    limit: i64,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let Some(baseline) = baseline_type(inbound) else {
        return Ok(Vec::new());
    };
    let (table, joins, changed) = changed_sql(inbound);
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select jsonb_build_object('externalId', m.external_entity_id, 'internalId', m.internal_entity_id,
           'checksum', m.sync_checksum, 'syncedAt', m.last_synced_at, 'baseline', b.sync_checksum)
         from integration_entity_mappings m
         join {table} on t.id = m.internal_entity_id {joins}
         join integration_entity_mappings b on b.connection_id = m.connection_id
           and b.external_entity_type = $3 and b.external_entity_id = m.external_entity_id
         where m.connection_id = $1 and m.external_entity_type = $2
           and m.external_entity_id not like 'pending:%' and m.external_entity_id not like 'failed:%'
           and {changed} > b.last_synced_at
         order by {changed} asc limit $4"
    )))
    .bind(connection_id)
    .bind(inbound)
    .bind(&baseline)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .map(|row| Candidate {
            external_id: string(row.get("externalId")).unwrap_or_default().to_owned(),
            internal_id: string(row.get("internalId")).unwrap_or_default().to_owned(),
            inbound_checksum: string(row.get("checksum")).map(str::to_owned),
            inbound_synced_at: string(row.get("syncedAt")).map(str::to_owned),
            baseline: string(row.get("baseline")).unwrap_or_default().to_owned(),
        })
        .collect())
}

/// Synced records without a baseline yet (imported before two-way, or
/// mapped by the Stripe push): (Moneybird id, WeldBooks id).
async fn unbaselined(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let Some(baseline) = baseline_type(inbound) else {
        return Ok(Vec::new());
    };
    let (table, _, _) = changed_sql(inbound);
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select m.external_entity_id, m.internal_entity_id
         from integration_entity_mappings m join {table} on t.id = m.internal_entity_id
         where m.connection_id = $1 and m.external_entity_type = $2
           and m.external_entity_id not like 'pending:%' and m.external_entity_id not like 'failed:%'
           and t.deleted_at is null
           and not exists (select 1 from integration_entity_mappings b where b.connection_id = m.connection_id
             and b.external_entity_type = $3 and b.external_entity_id = m.external_entity_id)
         limit $4"
    )))
    .bind(connection_id)
    .bind(inbound)
    .bind(&baseline)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// The `not exists` that keeps a WeldBooks record from being created twice:
/// a mapping of this type that is done, a claim in flight, or a failure
/// waiting for its retry. `$1` the connection, `$2` the type, `$3` / `$4`
/// the claim cutoffs.
const NOT_CLAIMED: &str = "not exists (
    select 1 from integration_entity_mappings p
    where p.connection_id = $1 and p.external_entity_type = $2 and p.internal_entity_id = t.id
      and ((p.external_entity_id not like 'pending:%' and p.external_entity_id not like 'failed:%')
        or (p.external_entity_id like 'pending:%' and p.updated_at > $3::timestamp)
        or (p.external_entity_id like 'failed:%' and p.updated_at > $4::timestamp)))";

/// A bill imported from any connector stays that connector's.
const NOT_IMPORTED: &str = "not exists (
    select 1 from integration_entity_mappings x
    where x.internal_entity_id = t.id and x.connection_id <> $1
      and x.external_entity_type not like 'moneybird_baseline_%')";

/// WeldBooks records made after `since` that Moneybird doesn't have yet:
/// accounting contacts, products, and bills once approved.
async fn new_records(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, sqlx::Error> {
    let (stale, retry) = cutoffs(force);
    let filter = match inbound {
        MB_CONTACT_TYPE => "parties t where t.deleted_at is null and t.archived_at is null
            and t.role in ('customer', 'supplier', 'both')"
            .to_owned(),
        PRODUCT_TYPE => "products t where t.deleted_at is null".to_owned(),
        _ => {
            format!("bills t where t.deleted_at is null and t.status = any($7) and {NOT_IMPORTED}")
        }
    };
    let sql = format!(
        "select t.id from {filter} and t.created_at >= $5::timestamp and {NOT_CLAIMED}
         order by t.created_at asc limit $6"
    );
    let mut query = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(connection_id)
        .bind(inbound)
        .bind(stale)
        .bind(retry)
        .bind(since)
        .bind(limit);
    if inbound == PURCHASE_INVOICE_TYPE {
        query = query.bind(&BILL_PUSHABLE[..]);
    }
    query.fetch_all(db).await
}

/// WeldBooks invoices made after `since` and sent, for the parent's
/// `push_invoice` (Moneybird external sales invoices).
pub(super) async fn new_invoice_ids(
    db: &PgPool,
    connection_id: &str,
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, sqlx::Error> {
    let (stale, retry) = cutoffs(force);
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select t.id from invoices t
         where t.deleted_at is null and t.type = 'standard' and t.status = any($7)
           and t.created_at >= $5::timestamp and {NOT_CLAIMED}
           and not exists (select 1 from integration_entity_mappings x
             where x.internal_entity_id = t.id and x.internal_entity_type = 'invoice'
               and x.external_entity_type <> $2 and x.external_entity_type not like 'moneybird_baseline_%')
         order by t.created_at asc limit $6"
    )))
    .bind(connection_id)
    .bind(MB_INVOICE_TYPE)
    .bind(stale)
    .bind(retry)
    .bind(since)
    .bind(limit)
    .bind(&super::PUSHABLE_STATUSES[..])
    .fetch_all(db)
    .await
}

/// A WeldBooks payment allocated to a document Moneybird has.
#[derive(Debug, Clone)]
struct PaymentRow {
    payment_id: String,
    amount: String,
    date: Option<String>,
    bank_transaction_id: Option<String>,
    document: String,
    base: &'static str,
}

fn base_of(kind: &str) -> Option<&'static str> {
    SALES_BASES
        .iter()
        .chain(BILL_BASES.iter())
        .find(|(k, _)| *k == kind)
        .map(|(_, base)| *base)
}

async fn new_payments(
    db: &PgPool,
    connection_id: &str,
    types: &[&str],
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<PaymentRow>, sqlx::Error> {
    let (stale, retry) = cutoffs(force);
    let types: Vec<String> = types.iter().map(|t| (*t).to_owned()).collect();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('paymentId', p.id, 'amount', coalesce(a.amount, p.amount)::text,
           'date', p.date, 'bankTransactionId', p.bank_transaction_id,
           'document', d.external_entity_id, 'kind', d.external_entity_type)
         from payments p
         left join payment_allocations a on a.payment_id = p.id and a.deleted_at is null
         join integration_entity_mappings d on d.connection_id = $1
           and d.internal_entity_id = coalesce(a.invoice_id, a.bill_id, p.invoice_id, p.bill_id)
           and d.external_entity_type = any($2)
           and d.external_entity_id not like 'pending:%' and d.external_entity_id not like 'failed:%'
         where p.deleted_at is null and p.created_at >= $3::timestamp
           and not exists (select 1 from integration_entity_mappings s
             where s.internal_entity_id = d.internal_entity_id and s.external_entity_type = $8)
           and not exists (select 1 from integration_entity_mappings x
             where x.connection_id = $1 and x.external_entity_type = $4 and x.internal_entity_id = p.id
               and (x.external_entity_id like d.external_entity_id || ':%'
                 or (x.external_entity_id like 'pending:' || d.external_entity_id || ':%' and x.updated_at > $5::timestamp)
                 or (x.external_entity_id like 'failed:' || d.external_entity_id || ':%' and x.updated_at > $6::timestamp)))
         order by p.created_at asc limit $7",
    )
    .bind(connection_id)
    .bind(&types)
    .bind(since)
    .bind(PAYMENT_TYPE)
    .bind(stale)
    .bind(retry)
    .bind(limit)
    .bind(STRIPE_INVOICE_TYPE)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .filter_map(|row| {
            Some(PaymentRow {
                payment_id: string(row.get("paymentId"))?.to_owned(),
                amount: string(row.get("amount")).unwrap_or("0").to_owned(),
                date: string(row.get("date")).map(str::to_owned),
                bank_transaction_id: string(row.get("bankTransactionId"))
                    .filter(|b| !b.is_empty())
                    .map(str::to_owned),
                document: string(row.get("document"))?.to_owned(),
                base: base_of(string(row.get("kind"))?)?,
            })
        })
        .collect())
}

/// Pushed payments whose WeldBooks payment was voided: (mapping row id,
/// Moneybird document id, Moneybird payment id, base path).
async fn voided_payments(
    db: &PgPool,
    connection_id: &str,
    types: &[&str],
    limit: i64,
) -> Result<Vec<(String, String, String, &'static str)>, sqlx::Error> {
    let types: Vec<String> = types.iter().map(|t| (*t).to_owned()).collect();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select x.id, x.external_entity_id, d.external_entity_type
         from integration_entity_mappings x
         join payments p on p.id = x.internal_entity_id
         join integration_entity_mappings d on d.connection_id = x.connection_id
           and d.external_entity_id = split_part(x.external_entity_id, ':', 1)
           and d.external_entity_type = any($3)
         where x.connection_id = $1 and x.external_entity_type = $2
           and x.external_entity_id not like 'pending:%' and x.external_entity_id not like 'failed:%'
           and p.deleted_at is not null
         limit $4",
    )
    .bind(connection_id)
    .bind(PAYMENT_TYPE)
    .bind(&types)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(row, external, kind)| {
            let (document, payment) = external.split_once(':')?;
            Some((
                row,
                document.to_owned(),
                payment.to_owned(),
                base_of(&kind)?,
            ))
        })
        .collect())
}

fn mapped_types(key: &str) -> &'static [&'static str] {
    match key {
        "contacts" => &[MB_CONTACT_TYPE],
        "products" => &[PRODUCT_TYPE],
        "invoices" => &[SALES_INVOICE_TYPE],
        _ => &[PURCHASE_INVOICE_TYPE, RECEIPT_TYPE],
    }
}

fn payment_types(key: &str) -> &'static [&'static str] {
    match key {
        "invoices" => &[SALES_INVOICE_TYPE, MB_INVOICE_TYPE],
        "bills" => &[PURCHASE_INVOICE_TYPE, RECEIPT_TYPE],
        _ => &[],
    }
}

/// Whether a pass has two-way work: SQL only, nothing asked of Moneybird.
pub(super) async fn has_work(
    db: &PgPool,
    connection: &Value,
    force: bool,
) -> Result<bool, sqlx::Error> {
    let id = connection["id"].as_str().unwrap_or_default();
    for key in outbound_objects(connection) {
        for inbound in mapped_types(key) {
            if !unbaselined(db, id, inbound, 1).await?.is_empty()
                || !changed_candidates(db, id, inbound, 1).await?.is_empty()
            {
                return Ok(true);
            }
        }
        let Some(since) = since(connection, key) else {
            continue;
        };
        let created = match key {
            "contacts" => !new_records(db, id, MB_CONTACT_TYPE, &since, force, 1)
                .await?
                .is_empty(),
            "products" => !new_records(db, id, PRODUCT_TYPE, &since, force, 1)
                .await?
                .is_empty(),
            "bills" => !new_records(db, id, PURCHASE_INVOICE_TYPE, &since, force, 1)
                .await?
                .is_empty(),
            _ => !new_invoice_ids(db, id, &since, force, 1).await?.is_empty(),
        };
        let types = payment_types(key);
        if created
            || (!types.is_empty()
                && (!new_payments(db, id, types, &since, force, 1)
                    .await?
                    .is_empty()
                    || !voided_payments(db, id, types, 1).await?.is_empty()))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

// ── the pass ────────────────────────────────────────────────────────────────

/// One two-way pass over the connection's outbound objects, inside the
/// parent's push pass (its request budget, run row and error samples).
pub(super) async fn run(pass: &mut Pass<'_>, force: bool) -> Step<()> {
    let connection = pass.connection.clone();
    for key in outbound_objects(&connection) {
        for inbound in mapped_types(key) {
            establish_baselines(pass, inbound).await?;
            let candidates =
                changed_candidates(pass.db, &pass.connection_id, inbound, MAX_PER_OBJECT).await?;
            if i64::try_from(candidates.len()).is_ok_and(|n| n >= MAX_PER_OBJECT) {
                pass.remaining = true;
            }
            for candidate in candidates {
                let step = match *inbound {
                    MB_CONTACT_TYPE => sync_contact(pass, &candidate).await,
                    PRODUCT_TYPE => sync_product(pass, &candidate).await,
                    SALES_INVOICE_TYPE => sync_sales_invoice(pass, &candidate).await,
                    kind => sync_bill(pass, kind, &candidate).await,
                };
                if let Err(error) = &step
                    && refused(error)
                {
                    park(pass, inbound, &candidate).await?;
                }
                settle(pass, &candidate.external_id, step)?;
            }
        }
        let Some(since) = since(&connection, key) else {
            continue;
        };
        match key {
            "contacts" => {
                for id in new_records(
                    pass.db,
                    &pass.connection_id,
                    MB_CONTACT_TYPE,
                    &since,
                    force,
                    MAX_PER_OBJECT,
                )
                .await?
                {
                    let step = create_contact(pass, &id, force).await;
                    settle(pass, &id, step)?;
                }
            }
            "products" => {
                for id in new_records(
                    pass.db,
                    &pass.connection_id,
                    PRODUCT_TYPE,
                    &since,
                    force,
                    MAX_PER_OBJECT,
                )
                .await?
                {
                    let step = create_product(pass, &id, force).await;
                    settle(pass, &id, step)?;
                }
            }
            "bills" => {
                for id in new_records(
                    pass.db,
                    &pass.connection_id,
                    PURCHASE_INVOICE_TYPE,
                    &since,
                    force,
                    MAX_PER_OBJECT,
                )
                .await?
                {
                    let step = create_bill(pass, &id, force).await;
                    settle(pass, &id, step)?;
                }
            }
            _ => {
                let ids =
                    new_invoice_ids(pass.db, &pass.connection_id, &since, force, MAX_PER_OBJECT)
                        .await?;
                for id in ids {
                    super::push_invoice(pass, &id, force, super::InvoiceSource::WeldBooks).await?;
                }
            }
        }
        let types = payment_types(key);
        if !types.is_empty() {
            for (row, document, payment, base) in
                voided_payments(pass.db, &pass.connection_id, types, MAX_PER_OBJECT).await?
            {
                let step = delete_payment(pass, &row, &document, &payment, base).await;
                settle(pass, &payment, step)?;
            }
            for payment in new_payments(
                pass.db,
                &pass.connection_id,
                types,
                &since,
                force,
                MAX_PER_OBJECT,
            )
            .await?
            {
                let label = payment.payment_id.clone();
                let step = create_payment(pass, &payment).await;
                settle(pass, &label, step)?;
            }
        }
    }
    Ok(())
}

/// A failure that trying again won't fix: Moneybird refused the change, or
/// WeldBooks can't make one (a missing ledger, a tax rate Moneybird lacks).
fn refused(error: &PushError) -> bool {
    match error {
        PushError::Budget => false,
        PushError::Connector(error) => !matches!(
            error.kind,
            crate::clients::Kind::Transient
                | crate::clients::Kind::RateLimit
                | crate::clients::Kind::Auth
        ),
        PushError::Other(_) => true,
    }
}

/// Parks a change Moneybird refused: its baseline keeps the old hash but
/// counts as seen now, so the record waits for its next edit instead of
/// being sent (and refused) on every pass.
async fn park(pass: &Pass<'_>, inbound: &str, candidate: &Candidate) -> Result<(), sqlx::Error> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    sqlx::query(
        "update integration_entity_mappings
         set last_synced_at = greatest(now() at time zone 'utc', last_synced_at),
           updated_at = now() at time zone 'utc'
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3",
    )
    .bind(&pass.connection_id)
    .bind(kind)
    .bind(&candidate.external_id)
    .execute(pass.db)
    .await
    .map(|_| ())
}

/// A record's step done: a failure is sampled on the run and the pass goes
/// on, unless it ends the pass (budget, rate limit) or the connection lost
/// its authorisation.
fn settle(pass: &mut Pass<'_>, label: &str, step: Step<()>) -> Step<()> {
    match step {
        Ok(()) => Ok(()),
        Err(error) if error.ends_pass() || error.is_auth() => Err(error),
        Err(error) => {
            pass.record(label, &error);
            Ok(())
        }
    }
}

async fn establish_baselines(pass: &mut Pass<'_>, inbound: &str) -> Step<()> {
    let missing = unbaselined(pass.db, &pass.connection_id, inbound, MAX_NEW_BASELINES).await?;
    if i64::try_from(missing.len()).is_ok_and(|n| n >= MAX_NEW_BASELINES) {
        pass.remaining = true;
    }
    for (external_id, internal_id) in missing {
        refresh_baseline(
            pass.db,
            &pass.connection_id,
            inbound,
            &external_id,
            &internal_id,
        )
        .await?;
    }
    Ok(())
}

// ── conflicts ───────────────────────────────────────────────────────────────

/// Which side a concurrent edit keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Winner {
    WeldBooks,
    Moneybird,
}

/// Moneybird changed the record since WeldBooks last saw it: its checksum
/// moved and its `updated_at` is past the last sync.
fn changed_in_moneybird(remote: &Value, candidate: &Candidate) -> bool {
    if candidate.inbound_checksum.as_deref() == Some(record_checksum(remote).as_str()) {
        return false;
    }
    let remote_at = string(remote.get("updated_at"))
        .and_then(crate::mappers::js_date_loose)
        .unwrap_or(f64::INFINITY);
    let synced_at = candidate
        .inbound_synced_at
        .as_deref()
        .map_or(0.0, utc_millis);
    remote_at > synced_at
}

/// A stored timestamp (UTC, without a zone, as `timestamp` columns read
/// back) in milliseconds; one with a zone keeps it.
fn utc_millis(text: &str) -> f64 {
    let text = text.trim();
    let zoned = text.ends_with('Z')
        || text.rsplit_once(['+', '-']).is_some_and(|(head, tail)| {
            head.contains('T') && tail.contains(':') && tail.len() <= 5
        });
    if zoned {
        return crate::mappers::js_date_loose(text).unwrap_or(0.0);
    }
    stamp_millis(text)
}

/// The newer edit wins; a tie keeps WeldBooks (it is the one being pushed).
fn winner(remote: &Value, changed_at: &str) -> Winner {
    let remote_at = string(remote.get("updated_at"))
        .and_then(crate::mappers::js_date_loose)
        .unwrap_or(0.0);
    if remote_at > stamp_millis(changed_at) {
        Winner::Moneybird
    } else {
        Winner::WeldBooks
    }
}

async fn record_conflict(
    pass: &Pass<'_>,
    entity_type: &str,
    candidate: &Candidate,
    weldbooks: &Value,
    remote: &Value,
    winner: Winner,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into integration_sync_conflicts (id, connection_id, entity_type, internal_entity_id,
           external_entity_id, conflict_type, internal_data, external_data, resolution, resolved_at, resolved_by)
         values ($1, $2, $3, $4, $5, 'concurrent_edit', $6, $7, $8, $9::timestamp, 'system')",
    )
    .bind(weldsuite_kit::generate_id("cnfl"))
    .bind(&pass.connection_id)
    .bind(entity_type)
    .bind(&candidate.internal_id)
    .bind(&candidate.external_id)
    .bind(weldbooks)
    .bind(remote)
    .bind(match winner {
        Winner::WeldBooks => "keep_internal",
        Winner::Moneybird => "keep_external",
    })
    .bind(now_iso())
    .execute(pass.db)
    .await
    .map(|_| ())
}

/// Reads the Moneybird record back and settles a concurrent edit. `None`:
/// nothing to push (Moneybird no longer has it, or its newer version was
/// imported over WeldBooks).
async fn check_remote(
    pass: &mut Pass<'_>,
    inbound: &str,
    candidate: &Candidate,
    remote: Option<Value>,
    weldbooks: &Value,
    changed_at: &str,
) -> Step<Option<Value>> {
    let Some(remote) = remote else {
        // Gone in Moneybird: its delete event (or the catch-up) removes it here.
        drop_baseline(
            pass.db,
            &pass.connection_id,
            inbound,
            &candidate.external_id,
        )
        .await?;
        return Ok(None);
    };
    if !changed_in_moneybird(&remote, candidate) {
        return Ok(Some(remote));
    }
    // An object sent one way only never imports, so WeldBooks keeps it.
    let one_way = object_direction(&pass.connection, object_key(inbound)) == "outbound";
    let won = if one_way {
        Winner::WeldBooks
    } else {
        winner(&remote, changed_at)
    };
    record_conflict(
        pass,
        internal_type(inbound),
        candidate,
        weldbooks,
        &remote,
        won,
    )
    .await?;
    if won == Winner::WeldBooks {
        return Ok(Some(remote));
    }
    import_remote(pass, inbound, remote).await?;
    Ok(None)
}

/// The [`OBJECTS`] key a mapping type belongs to.
fn object_key(inbound: &str) -> &'static str {
    match inbound {
        MB_CONTACT_TYPE => "contacts",
        PRODUCT_TYPE => "products",
        SALES_INVOICE_TYPE => "invoices",
        _ => "bills",
    }
}

fn sync_name(inbound: &str) -> &'static str {
    match inbound {
        MB_CONTACT_TYPE => "moneybird-contacts",
        PRODUCT_TYPE => "moneybird-products",
        SALES_INVOICE_TYPE => "moneybird-sales-invoices",
        RECEIPT_TYPE => "moneybird-receipts",
        _ => "moneybird-purchase-invoices",
    }
}

/// Moneybird's newer version, imported over WeldBooks (which re-baselines).
async fn import_remote(pass: &mut Pass<'_>, inbound: &str, remote: Value) -> Step<()> {
    if pass.workspace_id.is_empty() {
        // No workspace to import into from here: the webhook or the
        // catch-up brings it.
        return Ok(());
    }
    let answer = crate::webhooks::import_records(
        pass.db,
        pass.env,
        &pass.connection,
        &pass.workspace_id,
        sync_name(inbound),
        vec![remote],
    )
    .await?;
    if answer.ok {
        Ok(())
    } else {
        Err(PushError::Other(answer.message))
    }
}

/// After a write, the inbound mapping holds the checksum and time of the
/// record Moneybird answered with, so the echo of our own write imports as
/// unchanged.
async fn note_written(
    pass: &Pass<'_>,
    inbound: &str,
    external_id: &str,
    written: &Value,
) -> Result<(), sqlx::Error> {
    if !written.is_object() {
        return Ok(());
    }
    sqlx::query(
        "update integration_entity_mappings set sync_checksum = $1, last_synced_at = $2::timestamp,
           updated_at = $2::timestamp
         where connection_id = $3 and external_entity_type = $4 and external_entity_id = $5",
    )
    .bind(record_checksum(written))
    .bind(now_iso())
    .bind(&pass.connection_id)
    .bind(inbound)
    .bind(external_id)
    .execute(pass.db)
    .await
    .map(|_| ())
}

// ── contacts ────────────────────────────────────────────────────────────────

async fn sync_contact(pass: &mut Pass<'_>, candidate: &Candidate) -> Step<()> {
    let Some(state) = contact_state(pass.db, &candidate.internal_id).await? else {
        return Ok(());
    };
    let hashed = state.hashed();
    if state.deleted {
        pass.spend()?;
        pass.client
            .delete_contact(pass.http, &candidate.external_id)
            .await?;
        drop_baseline(
            pass.db,
            &pass.connection_id,
            MB_CONTACT_TYPE,
            &candidate.external_id,
        )
        .await?;
        pass.updated += 1;
        return Ok(());
    }
    if hashed.hash == candidate.baseline {
        return Ok(write_baseline(
            pass.db,
            &pass.connection_id,
            MB_CONTACT_TYPE,
            &candidate.external_id,
            &candidate.internal_id,
            &hashed,
        )
        .await?);
    }
    pass.spend()?;
    let remote = pass
        .client
        .get_contact(pass.http, &candidate.external_id)
        .await?;
    let Some(_) = check_remote(
        pass,
        MB_CONTACT_TYPE,
        candidate,
        remote,
        &state.update,
        &hashed.changed_at,
    )
    .await?
    else {
        return Ok(());
    };
    pass.spend()?;
    let written = pass
        .client
        .update_contact(pass.http, &candidate.external_id, state.update.clone())
        .await?;
    if state.archived {
        pass.spend()?;
        pass.client
            .archive_contact(pass.http, &candidate.external_id)
            .await?;
    }
    note_written(pass, MB_CONTACT_TYPE, &candidate.external_id, &written).await?;
    write_baseline(
        pass.db,
        &pass.connection_id,
        MB_CONTACT_TYPE,
        &candidate.external_id,
        &candidate.internal_id,
        &hashed,
    )
    .await?;
    pass.updated += 1;
    Ok(())
}

async fn create_contact(pass: &mut Pass<'_>, party_id: &str, force: bool) -> Step<()> {
    let Some(state) = contact_state(pass.db, party_id).await? else {
        return Ok(());
    };
    let Some(row) = claim(
        pass.db,
        &pass.connection_id.clone(),
        MB_CONTACT_TYPE,
        "party",
        party_id,
        force,
    )
    .await?
    else {
        return Ok(());
    };
    let created: Step<Value> = async {
        pass.spend()?;
        Ok(pass
            .client
            .create_contact(pass.http, state.create.clone())
            .await?)
    }
    .await;
    finish_create(
        pass,
        &row,
        party_id,
        MB_CONTACT_TYPE,
        created,
        &state.hashed(),
    )
    .await
}

/// A create's claim settled: the mapping and baseline on success, the
/// failure (retried later) otherwise.
async fn finish_create(
    pass: &mut Pass<'_>,
    row: &str,
    internal_id: &str,
    inbound: &str,
    created: Step<Value>,
    hashed: &Hashed,
) -> Step<()> {
    match created {
        Ok(record) => {
            let external_id = text_id(record.get("id"));
            if external_id.is_empty() {
                fail_claim(pass.db, row, internal_id).await?;
                return Err(PushError::Other(
                    "Moneybird did not return an id".to_owned(),
                ));
            }
            complete_claim(pass.db, row, &external_id, &record_checksum(&record)).await?;
            write_baseline(
                pass.db,
                &pass.connection_id,
                inbound,
                &external_id,
                internal_id,
                hashed,
            )
            .await?;
            pass.updated += 1;
            Ok(())
        }
        Err(error) if error.ends_pass() => {
            release_claim(pass.db, row).await?;
            Err(error)
        }
        Err(error) => {
            fail_claim(pass.db, row, internal_id).await?;
            Err(error)
        }
    }
}

// ── products ────────────────────────────────────────────────────────────────

/// The Moneybird sales tax rate for a product's VAT category: the standard
/// (highest) rate, the reduced (lowest non-zero) one, or 0%.
fn product_tax_rate(rates: &[crate::moneybird::TaxRate], state: &ProductState) -> Option<String> {
    let sales: Vec<&crate::moneybird::TaxRate> = rates
        .iter()
        .filter(|r| r.active && matches!(r.tax_rate_type.as_deref(), Some("sales_invoice") | None))
        .collect();
    let positive = || {
        sales
            .iter()
            .filter(|r| r.percentage.is_some_and(|p| p > 0.0))
    };
    let picked = if !state.taxable || matches!(state.vat_category.as_str(), "zero" | "exempt") {
        sales
            .iter()
            .find(|r| r.percentage.is_some_and(|p| p.abs() < 0.005))
    } else if state.vat_category == "reduced" {
        positive().min_by(|a, b| {
            a.percentage
                .partial_cmp(&b.percentage)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    } else {
        positive().max_by(|a, b| {
            a.percentage
                .partial_cmp(&b.percentage)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    };
    picked.map(|r| r.id.clone())
}

async fn sync_product(pass: &mut Pass<'_>, candidate: &Candidate) -> Step<()> {
    let Some(state) = product_state(pass.db, &candidate.internal_id).await? else {
        return Ok(());
    };
    let hashed = state.hashed();
    if state.deleted {
        pass.spend()?;
        pass.client
            .delete_product(pass.http, &candidate.external_id)
            .await?;
        drop_baseline(
            pass.db,
            &pass.connection_id,
            PRODUCT_TYPE,
            &candidate.external_id,
        )
        .await?;
        pass.updated += 1;
        return Ok(());
    }
    if hashed.hash == candidate.baseline {
        return Ok(write_baseline(
            pass.db,
            &pass.connection_id,
            PRODUCT_TYPE,
            &candidate.external_id,
            &candidate.internal_id,
            &hashed,
        )
        .await?);
    }
    pass.spend()?;
    let remote = pass
        .client
        .get_product(pass.http, &candidate.external_id)
        .await?;
    let Some(_) = check_remote(
        pass,
        PRODUCT_TYPE,
        candidate,
        remote,
        &state.body,
        &hashed.changed_at,
    )
    .await?
    else {
        return Ok(());
    };
    pass.spend()?;
    // Its ledger and tax rate stay Moneybird's.
    let written = pass
        .client
        .update_product(pass.http, &candidate.external_id, state.body.clone())
        .await?;
    note_written(pass, PRODUCT_TYPE, &candidate.external_id, &written).await?;
    write_baseline(
        pass.db,
        &pass.connection_id,
        PRODUCT_TYPE,
        &candidate.external_id,
        &candidate.internal_id,
        &hashed,
    )
    .await?;
    pass.updated += 1;
    Ok(())
}

async fn create_product(pass: &mut Pass<'_>, product_id: &str, force: bool) -> Step<()> {
    let Some(state) = product_state(pass.db, product_id).await? else {
        return Ok(());
    };
    let Some(revenue) = pass.setting("revenueLedgerAccountId") else {
        return Err(PushError::Other(
            "Pick a revenue ledger account on the Moneybird connection to send products".to_owned(),
        ));
    };
    let rates = tax_rates(pass).await?;
    let mut body = state.body.as_object().cloned().unwrap_or_default();
    body.insert("ledger_account_id".to_owned(), json!(revenue));
    if let Some(rate) = product_tax_rate(&rates, &state) {
        body.insert("tax_rate_id".to_owned(), json!(rate));
    }
    let Some(row) = claim(
        pass.db,
        &pass.connection_id.clone(),
        PRODUCT_TYPE,
        "product",
        product_id,
        force,
    )
    .await?
    else {
        return Ok(());
    };
    let created: Step<Value> = async {
        pass.spend()?;
        Ok(pass
            .client
            .create_product(pass.http, Value::Object(body))
            .await?)
    }
    .await;
    finish_create(
        pass,
        &row,
        product_id,
        PRODUCT_TYPE,
        created,
        &state.hashed(),
    )
    .await
}

// ── documents ───────────────────────────────────────────────────────────────

/// Days from issue to due date (Moneybird's `first_due_interval`).
fn due_interval(state: &DocState) -> Option<i64> {
    let issue = crate::mappers::js_date_loose(&ymd(string(state.row.get("issueDate"))))?;
    let due = crate::mappers::js_date_loose(&ymd(string(state.row.get("dueDate"))))?;
    let days = ((due - issue) / 86_400_000.0).round();
    (days.is_finite() && days >= 0.0).then_some(days as i64)
}

/// The lines a Moneybird document has, as WeldBooks reads them (with the
/// VAT percentage its tax totals give each).
fn remote_lines(remote: &Value) -> Vec<Line> {
    map_document_lines(remote)
        .iter()
        .map(Line::from_document)
        .collect()
}

fn same_rate(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() < 0.005,
        (None, None) => true,
        _ => false,
    }
}

/// The Moneybird lines for WeldBooks' lines, the document's current
/// details (`old`, read as `old_lines`) removed. A line takes the ledger of
/// the detail at its position, and that detail's tax rate when the VAT
/// percentage is the same; otherwise the rate is matched by percentage and
/// the ledger is the document's first one, else `fallback_ledger`.
#[allow(clippy::too_many_arguments)] // the document's and the connection's inputs
fn details_for(
    lines: &[Line],
    old: &[Value],
    old_lines: &[Line],
    rates: &[crate::moneybird::TaxRate],
    rate_kind: &str,
    breakdown: &[Value],
    overrides: &Map<String, Value>,
    fallback_ledger: Option<&str>,
) -> Result<Vec<Value>, String> {
    let first_ledger = old
        .iter()
        .find_map(|d| {
            string(d.get("ledger_account_id"))
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| fallback_ledger.map(str::to_owned));
    let mut details: Vec<Value> = old
        .iter()
        .filter_map(|d| {
            let id = text_id(d.get("id"));
            (!id.is_empty()).then(|| json!({ "id": id, "_destroy": true }))
        })
        .collect();
    for (index, line) in lines.iter().enumerate() {
        let percentage = line.tax_rate.as_deref().map(num).filter(|p| p.is_finite());
        let previous = old.get(index);
        let keeps_rate = old_lines.get(index).is_some_and(|o| {
            same_rate(
                o.tax_rate.as_deref().map(num).filter(|p| p.is_finite()),
                percentage,
            )
        });
        let tax_rate_id = match previous
            .map(|d| text_id(d.get("tax_rate_id")))
            .filter(|id| keeps_rate && !id.is_empty())
        {
            Some(id) => id,
            None => resolve_tax_rate_of(rate_kind, percentage, breakdown, rates, overrides)?,
        };
        let ledger = previous
            .and_then(|d| {
                string(d.get("ledger_account_id"))
                    .filter(|l| !l.is_empty())
                    .map(str::to_owned)
            })
            .or_else(|| first_ledger.clone())
            .ok_or_else(|| "Pick a ledger account on the Moneybird connection".to_owned())?;
        let (amount, price) = amount_and_price(
            Some(&line.quantity),
            &line.unit_price,
            line.total.as_deref(),
        );
        let mut detail = Map::new();
        detail.insert(
            "description".to_owned(),
            json!(slice_units(&line.description, 2000)),
        );
        detail.insert("amount".to_owned(), json!(amount));
        detail.insert("price".to_owned(), json!(price));
        detail.insert("tax_rate_id".to_owned(), json!(tax_rate_id));
        detail.insert("ledger_account_id".to_owned(), json!(ledger));
        if let Some(period) = &line.period
            && let (Some(from), Some(to)) = (string(period.get("from")), string(period.get("to")))
            && !from.is_empty()
            && !to.is_empty()
        {
            detail.insert(
                "period".to_owned(),
                json!(format!(
                    "{}..{}",
                    from.replace('-', ""),
                    to.replace('-', "")
                )),
            );
        }
        details.push(Value::Object(detail));
    }
    if lines.is_empty() {
        return Err("The document has no lines".to_owned());
    }
    Ok(details)
}

/// Whether WeldBooks' lines differ from the Moneybird document's.
fn lines_changed(state: &DocState, remote: &Value) -> bool {
    line_keys(&state.lines) != line_keys(&remote_lines(remote))
}

fn overrides(pass: &Pass<'_>) -> Map<String, Value> {
    pass.settings
        .get("taxRateOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn remote_details(remote: &Value) -> Vec<Value> {
    remote
        .get("details")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn sync_sales_invoice(pass: &mut Pass<'_>, candidate: &Candidate) -> Step<()> {
    let Some(state) = doc_state(pass.db, true, &candidate.internal_id).await? else {
        return Ok(());
    };
    let hashed = state.hashed();
    if !state.deleted && hashed.hash == candidate.baseline {
        return Ok(write_baseline(
            pass.db,
            &pass.connection_id,
            SALES_INVOICE_TYPE,
            &candidate.external_id,
            &candidate.internal_id,
            &hashed,
        )
        .await?);
    }
    pass.spend()?;
    let remote = pass
        .client
        .get_sales_invoice(pass.http, &candidate.external_id)
        .await?;
    let draft = remote.as_ref().is_some_and(|r| r["state"] == "draft");
    if state.deleted || state.status_class() == "cancelled" {
        if remote.is_some() && !draft {
            return Err(PushError::Other(
                "Moneybird keeps sent invoices: make a credit invoice for it in Moneybird"
                    .to_owned(),
            ));
        }
        if remote.is_some() {
            pass.spend()?;
            pass.client
                .delete_sales_invoice(pass.http, &candidate.external_id)
                .await?;
        }
        drop_baseline(
            pass.db,
            &pass.connection_id,
            SALES_INVOICE_TYPE,
            &candidate.external_id,
        )
        .await?;
        pass.updated += 1;
        return Ok(());
    }
    let Some(remote) = check_remote(
        pass,
        SALES_INVOICE_TYPE,
        candidate,
        remote,
        &state.row,
        &hashed.changed_at,
    )
    .await?
    else {
        return Ok(());
    };
    let mut written = Value::Null;
    if remote["state"] == "draft" {
        let mut patch = Map::new();
        let contact = resolve_contact(pass, &state.party()).await?;
        if text_id(remote.get("contact_id")) != contact {
            patch.insert("contact_id".to_owned(), json!(contact));
        }
        patch.insert("reference".to_owned(), json!(state.reference()));
        patch.insert(
            "invoice_date".to_owned(),
            json!(ymd(string(state.row.get("issueDate")))),
        );
        if let Some(days) = due_interval(&state) {
            patch.insert("first_due_interval".to_owned(), json!(days));
        }
        if lines_changed(&state, &remote) {
            let rates = tax_rates(pass).await?;
            let breakdown: Vec<Value> = state.row["taxBreakdown"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let revenue = pass.setting("revenueLedgerAccountId");
            let details = details_for(
                &state.lines,
                &remote_details(&remote),
                &remote_lines(&remote),
                &rates,
                "sales_invoice",
                &breakdown,
                &overrides(pass),
                revenue.as_deref(),
            )
            .map_err(PushError::Other)?;
            patch.insert("prices_are_incl_tax".to_owned(), json!(false));
            patch.insert("details_attributes".to_owned(), Value::Array(details));
        }
        pass.spend()?;
        written = pass
            .client
            .update_sales_invoice(pass.http, &candidate.external_id, Value::Object(patch))
            .await?;
        if state.status_class() != "draft" {
            pass.spend()?;
            written = pass
                .client
                .send_sales_invoice_manually(pass.http, &candidate.external_id)
                .await?;
        }
    } else if state.status_class() == "uncollectible" && remote["state"] != "uncollectible" {
        pass.spend()?;
        written = pass
            .client
            .mark_sales_invoice_uncollectible(pass.http, &candidate.external_id, &ymd(None))
            .await?;
    }
    note_written(pass, SALES_INVOICE_TYPE, &candidate.external_id, &written).await?;
    write_baseline(
        pass.db,
        &pass.connection_id,
        SALES_INVOICE_TYPE,
        &candidate.external_id,
        &candidate.internal_id,
        &hashed,
    )
    .await?;
    if !written.is_null() {
        pass.updated += 1;
    }
    Ok(())
}

/// Moneybird document states WeldBooks may still change.
fn editable_document(remote: &Value) -> bool {
    matches!(remote["state"].as_str(), Some("new" | "saved" | "draft"))
}

async fn pushed_by_weldbooks(pass: &Pass<'_>, bill_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "select 1 from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and internal_entity_id = $3 limit 1",
    )
    .bind(&pass.connection_id)
    .bind(PUSHED_BILL_TYPE)
    .bind(bill_id)
    .fetch_optional(pass.db)
    .await?;
    Ok(found.is_some())
}

async fn sync_bill(pass: &mut Pass<'_>, inbound: &str, candidate: &Candidate) -> Step<()> {
    let receipt = inbound == RECEIPT_TYPE;
    let Some(state) = doc_state(pass.db, false, &candidate.internal_id).await? else {
        return Ok(());
    };
    let hashed = state.hashed();
    if !state.deleted && hashed.hash == candidate.baseline {
        return Ok(write_baseline(
            pass.db,
            &pass.connection_id,
            inbound,
            &candidate.external_id,
            &candidate.internal_id,
            &hashed,
        )
        .await?);
    }
    pass.spend()?;
    let remote = if receipt {
        pass.client
            .get_receipt(pass.http, &candidate.external_id)
            .await?
    } else {
        pass.client
            .get_purchase_invoice(pass.http, &candidate.external_id)
            .await?
    };
    // A deleted draft goes; a rejected bill goes only when WeldBooks made it.
    let removes = state.deleted
        || (state.status_class() == "cancelled"
            && pushed_by_weldbooks(pass, &candidate.internal_id).await?);
    if removes {
        if let Some(remote) = &remote {
            if state.deleted && !editable_document(remote) {
                return Err(PushError::Other(
                    "Moneybird keeps booked documents: remove it in Moneybird".to_owned(),
                ));
            }
            pass.spend()?;
            pass.client
                .delete_document(pass.http, receipt, &candidate.external_id)
                .await?;
        }
        drop_baseline(
            pass.db,
            &pass.connection_id,
            inbound,
            &candidate.external_id,
        )
        .await?;
        pass.updated += 1;
        return Ok(());
    }
    let Some(remote) = check_remote(
        pass,
        inbound,
        candidate,
        remote,
        &state.row,
        &hashed.changed_at,
    )
    .await?
    else {
        return Ok(());
    };
    let mut written = Value::Null;
    if state.status_class() == "draft" && editable_document(&remote) {
        let mut patch = Map::new();
        let contact = resolve_contact(pass, &state.party()).await?;
        if text_id(remote.get("contact_id")) != contact {
            patch.insert("contact_id".to_owned(), json!(contact));
        }
        patch.insert("reference".to_owned(), json!(state.reference()));
        patch.insert(
            "date".to_owned(),
            json!(ymd(string(state.row.get("issueDate")))),
        );
        if !receipt {
            patch.insert(
                "due_date".to_owned(),
                json!(ymd(string(state.row.get("dueDate")))),
            );
        }
        if lines_changed(&state, &remote) {
            let rates = tax_rates(pass).await?;
            let expense = pass.setting("expenseLedgerAccountId");
            let details = details_for(
                &state.lines,
                &remote_details(&remote),
                &remote_lines(&remote),
                &rates,
                "purchase_invoice",
                &[],
                &overrides(pass),
                expense.as_deref(),
            )
            .map_err(PushError::Other)?;
            patch.insert("prices_are_incl_tax".to_owned(), json!(false));
            patch.insert("details_attributes".to_owned(), Value::Array(details));
        }
        pass.spend()?;
        written = pass
            .client
            .update_document(
                pass.http,
                receipt,
                &candidate.external_id,
                Value::Object(patch),
            )
            .await?;
    }
    note_written(pass, inbound, &candidate.external_id, &written).await?;
    write_baseline(
        pass.db,
        &pass.connection_id,
        inbound,
        &candidate.external_id,
        &candidate.internal_id,
        &hashed,
    )
    .await?;
    if !written.is_null() {
        pass.updated += 1;
    }
    Ok(())
}

async fn create_bill(pass: &mut Pass<'_>, bill_id: &str, force: bool) -> Step<()> {
    let Some(state) = doc_state(pass.db, false, bill_id).await? else {
        return Ok(());
    };
    let Some(expense) = pass.setting("expenseLedgerAccountId") else {
        return Err(PushError::Other(
            "Pick an expense ledger account on the Moneybird connection to send bills".to_owned(),
        ));
    };
    let Some(row) = claim(
        pass.db,
        &pass.connection_id.clone(),
        PURCHASE_INVOICE_TYPE,
        "bill",
        bill_id,
        force,
    )
    .await?
    else {
        return Ok(());
    };
    let created: Step<Value> = async {
        let contact = resolve_contact(pass, &state.party()).await?;
        let rates = tax_rates(pass).await?;
        let details = details_for(
            &state.lines,
            &[],
            &[],
            &rates,
            "purchase_invoice",
            &[],
            &overrides(pass),
            Some(&expense),
        )
        .map_err(PushError::Other)?;
        let body = json!({
            "contact_id": contact,
            "reference": state.reference(),
            "date": ymd(string(state.row.get("issueDate"))),
            "due_date": ymd(string(state.row.get("dueDate"))),
            "currency": state.currency(),
            "prices_are_incl_tax": false,
            "details_attributes": details,
        });
        pass.spend()?;
        Ok(pass.client.create_purchase_invoice(pass.http, body).await?)
    }
    .await;
    let external_id = created.as_ref().ok().map(|r| text_id(r.get("id")));
    finish_create(
        pass,
        &row,
        bill_id,
        PURCHASE_INVOICE_TYPE,
        created,
        &state.hashed(),
    )
    .await?;
    if let Some(external_id) = external_id.filter(|id| !id.is_empty()) {
        sqlx::query(
            "insert into integration_entity_mappings (id, connection_id, external_entity_type, external_entity_id,
               internal_entity_type, internal_entity_id, last_synced_at)
             values ($1, $2, $3, $4, 'bill', $5, $6::timestamp) on conflict do nothing",
        )
        .bind(weldsuite_kit::generate_id("iem"))
        .bind(&pass.connection_id)
        .bind(PUSHED_BILL_TYPE)
        .bind(&external_id)
        .bind(bill_id)
        .bind(now_iso())
        .execute(pass.db)
        .await?;
    }
    Ok(())
}

// ── payments ────────────────────────────────────────────────────────────────

async fn financial_mutation_id(
    pass: &Pass<'_>,
    bank_transaction_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select external_entity_id from integration_entity_mappings
         where connection_id = $1 and external_entity_type = 'moneybird_financial_mutation'
           and internal_entity_id = $2 limit 1",
    )
    .bind(&pass.connection_id)
    .bind(bank_transaction_id)
    .fetch_optional(pass.db)
    .await
}

async fn create_payment(pass: &mut Pass<'_>, payment: &PaymentRow) -> Step<()> {
    let pending = format!("pending:{}:{}", payment.document, payment.payment_id);
    // A failed or stale claim for this payment and document is retried.
    sqlx::query(
        "delete from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and internal_entity_id = $3
           and (external_entity_id like 'pending:' || $4 || ':%' or external_entity_id like 'failed:' || $4 || ':%')",
    )
    .bind(&pass.connection_id)
    .bind(PAYMENT_TYPE)
    .bind(&payment.payment_id)
    .bind(&payment.document)
    .execute(pass.db)
    .await?;
    let row: Option<String> = sqlx::query_scalar(
        "insert into integration_entity_mappings (id, created_at, updated_at, connection_id, external_entity_type,
           external_entity_id, internal_entity_type, internal_entity_id)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, 'payment', $6) on conflict do nothing returning id",
    )
    .bind(weldsuite_kit::generate_id("iem"))
    .bind(now_iso())
    .bind(&pass.connection_id)
    .bind(PAYMENT_TYPE)
    .bind(&pending)
    .bind(&payment.payment_id)
    .fetch_optional(pass.db)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let created: Step<Value> = async {
        let mut body = Map::new();
        body.insert(
            "payment_date".to_owned(),
            json!(ymd(payment.date.as_deref())),
        );
        body.insert(
            "price".to_owned(),
            json!(crate::js::to_fixed(num(&payment.amount), 2)),
        );
        let mutation = match &payment.bank_transaction_id {
            Some(id) => financial_mutation_id(pass, id).await?,
            None => None,
        };
        match mutation {
            Some(mutation) => {
                body.insert("financial_mutation_id".to_owned(), json!(mutation));
                body.insert("manual_payment_action".to_owned(), json!("bank_transfer"));
            }
            None => {
                body.insert(
                    "manual_payment_action".to_owned(),
                    json!("payment_without_proof"),
                );
            }
        }
        pass.spend()?;
        Ok(pass
            .client
            .create_payment(
                pass.http,
                payment.base,
                &payment.document,
                Value::Object(body),
            )
            .await?)
    }
    .await;
    match created {
        Ok(record) => {
            let id = text_id(record.get("id"));
            let external = if id.is_empty() {
                format!("{}:{}", payment.document, payment.payment_id)
            } else {
                format!("{}:{id}", payment.document)
            };
            sqlx::query(
                "update integration_entity_mappings set external_entity_id = $1, last_synced_at = $2::timestamp,
                   updated_at = $2::timestamp where id = $3",
            )
            .bind(external)
            .bind(now_iso())
            .bind(&row)
            .execute(pass.db)
            .await?;
            pass.updated += 1;
            Ok(())
        }
        Err(error) => {
            if error.ends_pass() {
                release_claim(pass.db, &row).await?;
            } else {
                sqlx::query("update integration_entity_mappings set external_entity_id = $1, updated_at = $2::timestamp where id = $3")
                    .bind(format!("failed:{}:{}", payment.document, payment.payment_id))
                    .bind(now_iso())
                    .bind(&row)
                    .execute(pass.db)
                    .await?;
            }
            Err(error)
        }
    }
}

async fn delete_payment(
    pass: &mut Pass<'_>,
    row: &str,
    document: &str,
    payment: &str,
    base: &str,
) -> Step<()> {
    pass.spend()?;
    pass.client
        .delete_payment(pass.http, base, document, payment)
        .await?;
    release_claim(pass.db, row).await?;
    pass.updated += 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(directions: &Value, enabled: &Value) -> Value {
        json!({
            "id": "cc_1",
            "provider": "moneybird",
            "direction": "inbound",
            "object_sync_directions": directions,
            "enabled_syncs": enabled,
            "settings": {},
        })
    }

    #[test]
    fn outbound_follows_object_directions_and_enabled_syncs() {
        let row = connection(
            &json!({ "contacts": "bidirectional", "invoices": "outbound", "bankTransactions": "outbound" }),
            &json!(["contacts", "invoices", "bankTransactions"]),
        );
        assert_eq!(outbound_objects(&row), vec!["contacts", "invoices"]);
        let disabled = connection(&json!({ "contacts": "outbound" }), &json!(["invoices"]));
        assert_eq!(outbound_objects(&disabled), Vec::<&str>::new());
        let mut all = connection(&Value::Null, &Value::Null);
        all["direction"] = json!("bidirectional");
        assert_eq!(outbound_objects(&all), OBJECTS.to_vec());
        let mut other = all.clone();
        other["provider"] = json!("stripe");
        assert_eq!(outbound_objects(&other), Vec::<&str>::new());
    }

    #[test]
    fn since_is_stamped_on_and_cleared_off() {
        let mut row = connection(&json!({ "contacts": "outbound" }), &Value::Null);
        let settings = settings_with_since(&row).expect("stamped");
        assert!(settings["moneybirdTwoWay"]["since"]["contacts"].is_string());
        assert!(
            settings["moneybirdTwoWay"]["since"]
                .get("products")
                .is_none()
        );
        row["settings"] = settings;
        assert!(settings_with_since(&row).is_none(), "already in line");
        row["object_sync_directions"] = json!({ "contacts": "inbound" });
        let cleared = settings_with_since(&row).expect("cleared");
        assert!(
            cleared["moneybirdTwoWay"]["since"]
                .get("contacts")
                .is_none()
        );
    }

    #[test]
    fn baseline_types_and_bookkeeping_rows() {
        assert_eq!(
            baseline_type(MB_CONTACT_TYPE).as_deref(),
            Some("moneybird_baseline_contact")
        );
        assert_eq!(
            baseline_type(PURCHASE_INVOICE_TYPE).as_deref(),
            Some("moneybird_baseline_purchase_invoice")
        );
        assert!(baseline_type("moneybird_financial_mutation").is_none());
        assert!(baseline_type(MB_INVOICE_TYPE).is_none());
        assert!(is_bookkeeping_type("moneybird_baseline_receipt"));
        assert!(is_bookkeeping_type(PAYMENT_TYPE));
        assert!(!is_bookkeeping_type(MB_CONTACT_TYPE));
        assert_eq!(base_of(MB_INVOICE_TYPE), Some("external_sales_invoices"));
        assert_eq!(base_of(RECEIPT_TYPE), Some("documents/receipts"));
    }

    fn doc(status: &str, lines: Vec<Line>) -> DocState {
        DocState {
            invoice: true,
            row: json!({
                "id": "inv_1", "status": status, "contactId": "party_1", "reference": "R-1",
                "issueDate": "2026-11-01T00:00:00.000Z", "dueDate": "2026-11-15T00:00:00.000Z", "currency": "eur",
            }),
            lines,
            deleted: false,
            changed_at: "2026-11-01 10:00:00.000000".to_owned(),
        }
    }

    fn line(description: &str, quantity: &str, price: &str, rate: Option<&str>) -> Line {
        Line {
            description: description.to_owned(),
            quantity: quantity.to_owned(),
            unit_price: price.to_owned(),
            tax_rate: rate.map(str::to_owned),
            total: None,
            period: None,
        }
    }

    #[test]
    fn document_hash_ignores_payment_states_and_number_formatting() {
        let base = doc("sent", vec![line("Work", "2", "50", Some("21"))]);
        let paid = doc(
            "paid",
            vec![line("Work ", "2.0000", "50.0000", Some("21.00"))],
        );
        assert_eq!(base.hashed().hash, paid.hashed().hash);
        let draft = doc("draft", vec![line("Work", "2", "50", Some("21"))]);
        assert_ne!(base.hashed().hash, draft.hashed().hash);
        let edited = doc("sent", vec![line("Work", "3", "50", Some("21"))]);
        assert_ne!(base.hashed().hash, edited.hashed().hash);
        assert_eq!(
            doc("uncollectible", Vec::new()).status_class(),
            "uncollectible"
        );
        assert_eq!(due_interval(&base), Some(14));
    }

    #[test]
    fn line_changes_compare_against_moneybird_details() {
        let state = doc("draft", vec![line("Work", "2", "50", None)]);
        let same = json!({ "details": [{ "id": "d1", "description": "Work", "amount": "2", "price": "50.0" }] });
        assert!(!lines_changed(&state, &same));
        let other = json!({ "details": [{ "id": "d1", "description": "Work", "amount": "1", "price": "50.0" }] });
        assert!(lines_changed(&state, &other));
    }

    #[test]
    fn replaced_details_keep_ledger_and_destroy_the_old_ones() {
        let rates = vec![crate::moneybird::TaxRate {
            id: "tr21".to_owned(),
            name: "21% btw".to_owned(),
            percentage: Some(21.0),
            tax_rate_type: Some("sales_invoice".to_owned()),
            country: None,
            active: true,
        }];
        let old = vec![
            json!({ "id": "d1", "description": "Old", "amount": "1", "price": "10", "tax_rate_id": "trX", "ledger_account_id": "la1" }),
        ];
        let nine = vec![line("Old", "1", "10", Some("9"))];
        let details = details_for(
            &[
                line("New", "1", "20", Some("21")),
                line("Extra", "1", "5", Some("21")),
            ],
            &old,
            &nine,
            &rates,
            "sales_invoice",
            &[],
            &Map::new(),
            Some("fallback"),
        )
        .expect("details");
        assert_eq!(details[0], json!({ "id": "d1", "_destroy": true }));
        assert_eq!(details[1]["ledger_account_id"], "la1");
        assert_eq!(
            details[1]["tax_rate_id"], "tr21",
            "another percentage: matched again"
        );
        assert_eq!(
            details[2]["ledger_account_id"], "la1",
            "the document's first ledger"
        );
        let kept = details_for(
            &[line("New", "1", "20", Some("9"))],
            &old,
            &nine,
            &rates,
            "sales_invoice",
            &[],
            &Map::new(),
            None,
        )
        .expect("details");
        assert_eq!(
            kept[1]["tax_rate_id"], "trX",
            "same percentage: the detail's own rate"
        );
        assert!(
            details_for(
                &[],
                &old,
                &nine,
                &rates,
                "sales_invoice",
                &[],
                &Map::new(),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn conflicts_need_a_moved_checksum_and_a_later_moneybird_edit() {
        let remote = json!({ "id": "1", "updated_at": "2026-11-02T10:00:00.000Z" });
        let mut candidate = Candidate {
            external_id: "1".to_owned(),
            internal_id: "party_1".to_owned(),
            inbound_checksum: Some(record_checksum(&remote)),
            inbound_synced_at: Some("2026-11-01T10:00:00.000Z".to_owned()),
            baseline: String::new(),
        };
        assert!(!changed_in_moneybird(&remote, &candidate), "same record");
        candidate.inbound_checksum = Some("other".to_owned());
        assert!(changed_in_moneybird(&remote, &candidate));
        candidate.inbound_synced_at = Some("2026-11-03T10:00:00.000Z".to_owned());
        assert!(
            !changed_in_moneybird(&remote, &candidate),
            "synced after it"
        );
        candidate.inbound_synced_at = Some("2026-11-02T10:30:00.123456".to_owned());
        assert!(
            !changed_in_moneybird(&remote, &candidate),
            "a zoneless stamp reads as UTC"
        );
        assert_eq!(
            utc_millis("2026-11-02T10:00:00.000Z"),
            utc_millis("2026-11-02 10:00:00.000000")
        );
        assert_eq!(
            utc_millis("2026-11-02T11:00:00+01:00"),
            utc_millis("2026-11-02T10:00:00Z")
        );
        assert_eq!(
            winner(&remote, "2026-11-02 09:00:00.000000"),
            Winner::Moneybird
        );
        assert_eq!(
            winner(&remote, "2026-11-02 11:00:00.000000"),
            Winner::WeldBooks
        );
    }

    #[test]
    fn only_lasting_failures_park_a_record() {
        use crate::clients::{ConnectorError, Kind};
        assert!(refused(&PushError::Other("no ledger".to_owned())));
        assert!(refused(&PushError::Connector(ConnectorError::new(
            "refused",
            422,
            Kind::Permanent
        ))));
        assert!(!refused(&PushError::Connector(ConnectorError::new(
            "down",
            502,
            Kind::Transient
        ))));
        assert!(!refused(&PushError::Connector(ConnectorError::new(
            "slow",
            429,
            Kind::RateLimit
        ))));
        assert!(!refused(&PushError::Budget));
    }

    #[test]
    fn product_tax_follows_the_vat_category() {
        let rate = |id: &str, pct: f64| crate::moneybird::TaxRate {
            id: id.to_owned(),
            name: id.to_owned(),
            percentage: Some(pct),
            tax_rate_type: Some("sales_invoice".to_owned()),
            country: None,
            active: true,
        };
        let rates = vec![rate("high", 21.0), rate("low", 9.0), rate("zero", 0.0)];
        let state = |category: &str, taxable: bool| ProductState {
            body: Value::Null,
            deleted: false,
            changed_at: String::new(),
            vat_category: category.to_owned(),
            taxable,
        };
        assert_eq!(
            product_tax_rate(&rates, &state("standard", true)).as_deref(),
            Some("high")
        );
        assert_eq!(
            product_tax_rate(&rates, &state("reduced", true)).as_deref(),
            Some("low")
        );
        assert_eq!(
            product_tax_rate(&rates, &state("standard", false)).as_deref(),
            Some("zero")
        );
    }
}

#[cfg(test)]
mod db_tests;
