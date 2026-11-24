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

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Alias, BinOper, Expr, Func, OnConflict, Order, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbBackend, DbErr, EntityTrait, FromQueryResult,
    JoinType, QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::{
    bill_items, bills, companies, integration_entity_mappings as mappings,
    integration_sync_conflicts as conflicts, invoice_items, invoices, parties, payment_allocations,
    payments, people, products,
};

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
pub async fn stamp_since(db: &PgPool, connection: &Value) -> Result<Value, DbErr> {
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
) -> Result<(), DbErr> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    let now = utc_now();
    mappings::Entity::insert(mappings::ActiveModel {
        id: Set(weldsuite_kit::generate_id("iem")),
        created_at: Set(now),
        updated_at: Set(now),
        connection_id: Set(connection_id.to_owned()),
        external_entity_type: Set(kind),
        external_entity_id: Set(external_id.to_owned()),
        internal_entity_type: Set(internal_type(inbound).to_owned()),
        internal_entity_id: Set(internal_id.to_owned()),
        last_synced_at: Set(Some(stamp_at(&hashed.changed_at)?)),
        sync_checksum: Set(Some(hashed.hash.clone())),
    })
    .on_conflict(
        OnConflict::columns([
            mappings::Column::ConnectionId,
            mappings::Column::ExternalEntityType,
            mappings::Column::ExternalEntityId,
        ])
        .update_columns([
            mappings::Column::InternalEntityId,
            mappings::Column::SyncChecksum,
            mappings::Column::LastSyncedAt,
            mappings::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await
    .map(|_| ())
}

/// Forgets a record's baseline: it is gone on one side.
pub async fn drop_baseline(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    external_id: &str,
) -> Result<(), DbErr> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    mappings::Entity::delete_many()
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(kind))
        .filter(mappings::Column::ExternalEntityId.eq(external_id))
        .exec(&orm(db))
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
) -> Result<(), DbErr> {
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

async fn hash_of(db: &PgPool, inbound: &str, internal_id: &str) -> Result<Option<Hashed>, DbErr> {
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
) -> Result<bool, DbErr> {
    let cutoff = super::at_millis(crate::js::now_ms() - STALE_CLAIM_MS);
    let found: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::Id)
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(inbound))
        .filter(mappings::Column::ExternalEntityId.like("pending:%"))
        .filter(mappings::Column::UpdatedAt.gt(cutoff))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

// ── the WeldBooks side, as Moneybird would get it ───────────────────────────

/// `to_char(at, 'YYYY-MM-DD HH24:MI:SS.US')`: a change time as a baseline
/// keeps it, to the microsecond.
fn stamp(at: PrimitiveDateTime) -> String {
    at.format(time::macros::format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:6]"
    ))
    .unwrap_or_default()
}

/// A [`stamp`] as `$n::timestamp` reads it back.
fn stamp_at(text: &str) -> Result<PrimitiveDateTime, DbErr> {
    PrimitiveDateTime::parse(
        text,
        time::macros::format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:6]"
        ),
    )
    .map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{text}\""
        ))
    })
}

/// `greatest(at, …)`: the latest of the times that are set.
fn latest(at: PrimitiveDateTime, others: &[Option<PrimitiveDateTime>]) -> PrimitiveDateTime {
    others.iter().flatten().fold(at, |a, b| a.max(*b))
}

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

/// `left join companies c on c.id = p.company_id`.
fn party_company() -> RelationDef {
    parties::Entity::belongs_to(companies::Entity)
        .from(parties::Column::CompanyId)
        .to(companies::Column::Id)
        .into()
}

/// `left join people pe on pe.id = p.person_id`.
fn party_person() -> RelationDef {
    parties::Entity::belongs_to(people::Entity)
        .from(parties::Column::PersonId)
        .to(people::Column::Id)
        .into()
}

/// A party's flags and the change times of it, its company and its person.
type PartyTimes = (
    Option<PrimitiveDateTime>,
    Option<PrimitiveDateTime>,
    PrimitiveDateTime,
    Option<PrimitiveDateTime>,
    Option<PrimitiveDateTime>,
);

async fn contact_state(db: &PgPool, party_id: &str) -> Result<Option<ContactState>, DbErr> {
    // `p.deleted_at`, `p.archived_at`, and `greatest(p.updated_at,
    // p.deleted_at, p.archived_at, c.updated_at, pe.updated_at)` from them.
    let times: Option<PartyTimes> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::DeletedAt,
            parties::Column::ArchivedAt,
            parties::Column::UpdatedAt,
        ])
        .column_as(companies::Column::UpdatedAt, "company_updated_at")
        .column_as(people::Column::UpdatedAt, "person_updated_at")
        .join(JoinType::LeftJoin, party_company())
        .join(JoinType::LeftJoin, party_person())
        .filter(parties::Column::Id.eq(party_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((deleted_at, archived_at, updated_at, company_at, person_at)) = times else {
        return Ok(None);
    };
    let (deleted, archived) = (deleted_at.is_some(), archived_at.is_some());
    let changed_at = stamp(latest(
        updated_at,
        &[deleted_at, archived_at, company_at, person_at],
    ));
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

/// The product columns Moneybird's product is made of.
#[derive(FromQueryResult)]
struct ProductRow {
    name: String,
    description: Option<String>,
    sku: Option<String>,
    price: BigDecimal,
    currency: Option<String>,
    deleted_at: Option<PrimitiveDateTime>,
    updated_at: PrimitiveDateTime,
    vat_category: String,
    taxable: Option<bool>,
}

async fn product_state(db: &PgPool, id: &str) -> Result<Option<ProductState>, DbErr> {
    let row = products::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            products::Column::Name,
            products::Column::Description,
            products::Column::Sku,
            products::Column::Price,
            products::Column::Currency,
            products::Column::DeletedAt,
            products::Column::UpdatedAt,
            products::Column::VatCategory,
            products::Column::Taxable,
        ])
        .into_model::<ProductRow>()
        .one(&orm(db))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let name = row.name;
    let mut body = Map::new();
    body.insert("title".to_owned(), json!(slice_units(&name, 255)));
    let description = row
        .description
        .as_deref()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or(name.as_str());
    body.insert(
        "description".to_owned(),
        json!(slice_units(description, 4096)),
    );
    if let Some(sku) = row.sku.as_deref().filter(|s| !s.trim().is_empty()) {
        body.insert("identifier".to_owned(), json!(sku.trim()));
    }
    // `price::text`, read as a number.
    body.insert(
        "price".to_owned(),
        json!(crate::js::to_fixed(num(&row.price.to_plain_string()), 2)),
    );
    body.insert(
        "currency".to_owned(),
        json!(
            row.currency
                .as_deref()
                .filter(|c| !c.is_empty())
                .unwrap_or("EUR")
                .to_uppercase()
        ),
    );
    Ok(Some(ProductState {
        body: Value::Object(body),
        deleted: row.deleted_at.is_some(),
        changed_at: stamp(latest(row.updated_at, &[row.deleted_at])),
        vat_category: row.vat_category,
        taxable: row.taxable.unwrap_or(true),
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

/// A document line's columns: description, quantity, unit price, VAT
/// percentage, line total and service period.
type ItemRow = (
    String,
    Option<BigDecimal>,
    BigDecimal,
    Option<BigDecimal>,
    Option<BigDecimal>,
    Option<Value>,
);

/// `n::text` of a `numeric(p, scale)` column: exactly `scale` decimals.
fn numeric_text(n: &BigDecimal, scale: i64) -> String {
    n.with_scale(scale).to_plain_string()
}

async fn doc_state(db: &PgPool, invoice: bool, id: &str) -> Result<Option<DocState>, DbErr> {
    let db = &orm(db);
    // The row as Drizzle reads it (`total` as text, as `numeric` prints), its
    // change time `greatest(updated_at, deleted_at)`, and its live lines in
    // `sort_order`.
    let (row, deleted_at, updated_at, items): (Value, _, _, Vec<ItemRow>) = if invoice {
        let Some(row) = invoices::Entity::find_by_id(id.to_owned()).one(db).await? else {
            return Ok(None);
        };
        let items = invoice_items::Entity::find()
            .select_only()
            .columns([
                invoice_items::Column::Description,
                invoice_items::Column::Quantity,
                invoice_items::Column::UnitPrice,
                invoice_items::Column::TaxRate,
                invoice_items::Column::LineTotal,
                invoice_items::Column::Period,
            ])
            .filter(invoice_items::Column::InvoiceId.eq(id))
            .filter(invoice_items::Column::DeletedAt.is_null())
            .order_by_asc(invoice_items::Column::SortOrder)
            .into_tuple()
            .all(db)
            .await?;
        let (deleted_at, updated_at) = (row.deleted_at, row.updated_at);
        let row = serde_json::to_value(row).map_err(crate::connections::json_error)?;
        (row, deleted_at, updated_at, items)
    } else {
        let Some(row) = bills::Entity::find_by_id(id.to_owned()).one(db).await? else {
            return Ok(None);
        };
        let items = bill_items::Entity::find()
            .select_only()
            .columns([
                bill_items::Column::Description,
                bill_items::Column::Quantity,
                bill_items::Column::UnitPrice,
                bill_items::Column::TaxRate,
                bill_items::Column::LineTotal,
                bill_items::Column::Period,
            ])
            .filter(bill_items::Column::BillId.eq(id))
            .filter(bill_items::Column::DeletedAt.is_null())
            .order_by_asc(bill_items::Column::SortOrder)
            .into_tuple()
            .all(db)
            .await?;
        let (deleted_at, updated_at) = (row.deleted_at, row.updated_at);
        let row = serde_json::to_value(row).map_err(crate::connections::json_error)?;
        (row, deleted_at, updated_at, items)
    };
    let changed_at = stamp(latest(updated_at, &[deleted_at]));
    let mut row = row;
    row["changedStamp"] = json!(changed_at);
    // Each column as `::text` prints it (`numeric(10, 4)`, `numeric(18, 4)`,
    // `numeric(7, 4)`, `numeric(18, 2)`).
    let lines = items
        .into_iter()
        .map(
            |(description, quantity, unit_price, tax_rate, total, period)| Line {
                description,
                quantity: quantity.map_or_else(|| "1".to_owned(), |q| numeric_text(&q, 4)),
                unit_price: numeric_text(&unit_price, 4),
                tax_rate: tax_rate.map(|r| numeric_text(&r, 4)),
                total: total.map(|t| numeric_text(&t, 2)),
                period: period.filter(|p| !p.is_null()),
            },
        )
        .collect();
    Ok(Some(DocState {
        invoice,
        deleted: deleted_at.is_some(),
        changed_at,
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

/// A mapped record's table joined (as `t`, on `t.id =
/// m.internal_entity_id`): its change time and its `deleted_at`.
struct Joined {
    changed: Expr,
    deleted_at: Expr,
}

/// How a mapped record of this type is read: its table (as `t`) and the
/// joins its change time needs, added to `select`.
fn join_record(select: &mut SelectStatement, inbound: &str) -> Joined {
    use sea_orm::ExprTrait as _;
    match inbound {
        MB_CONTACT_TYPE => {
            let (t, c, pe) = (|| Alias::new("t"), || Alias::new("c"), || Alias::new("pe"));
            let col = |column: parties::Column| Expr::col((t(), column));
            select
                .join_as(
                    JoinType::InnerJoin,
                    parties::Entity,
                    t(),
                    col(parties::Column::Id)
                        .equals((Alias::new("m"), mappings::Column::InternalEntityId)),
                )
                .join_as(
                    JoinType::LeftJoin,
                    companies::Entity,
                    c(),
                    Expr::col((c(), companies::Column::Id)).eq(col(parties::Column::CompanyId)),
                )
                .join_as(
                    JoinType::LeftJoin,
                    people::Entity,
                    pe(),
                    Expr::col((pe(), people::Column::Id)).eq(col(parties::Column::PersonId)),
                );
            Joined {
                changed: Func::greatest([
                    col(parties::Column::UpdatedAt),
                    col(parties::Column::DeletedAt),
                    col(parties::Column::ArchivedAt),
                    Expr::col((c(), companies::Column::UpdatedAt)),
                    Expr::col((pe(), people::Column::UpdatedAt)),
                ])
                .into(),
                deleted_at: col(parties::Column::DeletedAt),
            }
        }
        PRODUCT_TYPE => join_plain(
            select,
            products::Entity,
            [
                products::Column::Id,
                products::Column::UpdatedAt,
                products::Column::DeletedAt,
            ],
        ),
        SALES_INVOICE_TYPE => join_plain(
            select,
            invoices::Entity,
            [
                invoices::Column::Id,
                invoices::Column::UpdatedAt,
                invoices::Column::DeletedAt,
            ],
        ),
        _ => join_plain(
            select,
            bills::Entity,
            [
                bills::Column::Id,
                bills::Column::UpdatedAt,
                bills::Column::DeletedAt,
            ],
        ),
    }
}

/// [`join_record`] of a product, invoice or bill (its `id`, `updated_at`
/// and `deleted_at`): changed at `greatest(t.updated_at, t.deleted_at)`.
fn join_plain<E: EntityTrait>(
    select: &mut SelectStatement,
    entity: E,
    [id, updated_at, deleted_at]: [E::Column; 3],
) -> Joined {
    use sea_orm::ExprTrait as _;
    let t = || Alias::new("t");
    select.join_as(
        JoinType::InnerJoin,
        entity,
        t(),
        Expr::col((t(), id)).equals((Alias::new("m"), mappings::Column::InternalEntityId)),
    );
    Joined {
        changed: Func::greatest([Expr::col((t(), updated_at)), Expr::col((t(), deleted_at))])
            .into(),
        deleted_at: Expr::col((t(), deleted_at)),
    }
}

/// `m.connection_id = $1 and m.external_entity_type = $2 and
/// m.external_entity_id not like 'pending:%' and … not like 'failed:%'`: the
/// done mappings of this type on the connection, as `m`.
fn done_mappings(connection_id: &str, inbound: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    let col = |column: mappings::Column| Expr::col((Alias::new("m"), column));
    Condition::all()
        .add(col(mappings::Column::ConnectionId).eq(connection_id))
        .add(col(mappings::Column::ExternalEntityType).eq(inbound))
        .add(col(mappings::Column::ExternalEntityId).not_like("pending:%"))
        .add(col(mappings::Column::ExternalEntityId).not_like("failed:%"))
}

/// `b.connection_id = m.connection_id and b.external_entity_type = $3 and
/// b.external_entity_id = m.external_entity_id`: the mapping's baseline, as
/// `b`.
fn baseline_of_mapping(baseline: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    let (m, b) = (|| Alias::new("m"), || Alias::new("b"));
    Condition::all()
        .add(
            Expr::col((b(), mappings::Column::ConnectionId))
                .equals((m(), mappings::Column::ConnectionId)),
        )
        .add(Expr::col((b(), mappings::Column::ExternalEntityType)).eq(baseline))
        .add(
            Expr::col((b(), mappings::Column::ExternalEntityId))
                .equals((m(), mappings::Column::ExternalEntityId)),
        )
}

/// What [`changed_candidates`] reads of a mapping and its baseline.
#[derive(FromQueryResult)]
struct CandidateRow {
    external_id: String,
    internal_id: String,
    checksum: Option<String>,
    synced_at: Option<PrimitiveDateTime>,
    baseline: Option<String>,
}

async fn changed_candidates(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    limit: i64,
) -> Result<Vec<Candidate>, DbErr> {
    let Some(baseline) = baseline_type(inbound) else {
        return Ok(Vec::new());
    };
    let select = changed_query(connection_id, inbound, &baseline, limit);
    let rows = CandidateRow::find_by_statement(DbBackend::Postgres.build(&select))
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| Candidate {
            external_id: row.external_id,
            internal_id: row.internal_id,
            inbound_checksum: row.checksum,
            // As `to_jsonb` and `js_row` handed it on: `toISOString()`.
            inbound_synced_at: row
                .synced_at
                .map(|at| weldsuite_events::iso_timestamp(at.assume_utc())),
            baseline: row.baseline.unwrap_or_default(),
        })
        .collect())
}

/// [`changed_candidates`]' statement: the done mappings `m` of this type
/// whose record `t` changed after their baseline `b` was taken, oldest
/// change first.
fn changed_query(
    connection_id: &str,
    inbound: &str,
    baseline: &str,
    limit: i64,
) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let (m, b) = (|| Alias::new("m"), || Alias::new("b"));
    let mut select = Query::select();
    select
        .expr_as(
            Expr::col((m(), mappings::Column::ExternalEntityId)),
            Alias::new("external_id"),
        )
        .expr_as(
            Expr::col((m(), mappings::Column::InternalEntityId)),
            Alias::new("internal_id"),
        )
        .expr_as(
            Expr::col((m(), mappings::Column::SyncChecksum)),
            Alias::new("checksum"),
        )
        .expr_as(
            Expr::col((m(), mappings::Column::LastSyncedAt)),
            Alias::new("synced_at"),
        )
        .expr_as(
            Expr::col((b(), mappings::Column::SyncChecksum)),
            Alias::new("baseline"),
        )
        .from_as(mappings::Entity, m());
    let record = join_record(&mut select, inbound);
    select
        .join_as(
            JoinType::InnerJoin,
            mappings::Entity,
            b(),
            baseline_of_mapping(baseline),
        )
        .cond_where(
            done_mappings(connection_id, inbound).add(
                record
                    .changed
                    .clone()
                    .gt(Expr::col((b(), mappings::Column::LastSyncedAt))),
            ),
        )
        .order_by_expr(record.changed, Order::Asc)
        .limit(u64::try_from(limit).unwrap_or(0));
    select
}

/// What [`unbaselined`] reads of a mapping.
#[derive(FromQueryResult)]
struct MappedRow {
    external_id: String,
    internal_id: String,
}

/// Synced records without a baseline yet (imported before two-way, or
/// mapped by the Stripe push): (Moneybird id, WeldBooks id).
async fn unbaselined(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, DbErr> {
    let Some(baseline) = baseline_type(inbound) else {
        return Ok(Vec::new());
    };
    let select = unbaselined_query(connection_id, inbound, &baseline, limit);
    Ok(
        MappedRow::find_by_statement(DbBackend::Postgres.build(&select))
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|row| (row.external_id, row.internal_id))
            .collect(),
    )
}

/// [`unbaselined`]'s statement: the done mappings `m` of this type whose
/// live record `t` has no baseline `b`.
fn unbaselined_query(
    connection_id: &str,
    inbound: &str,
    baseline: &str,
    limit: i64,
) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let (m, b) = (|| Alias::new("m"), || Alias::new("b"));
    let mut select = Query::select();
    select
        .expr_as(
            Expr::col((m(), mappings::Column::ExternalEntityId)),
            Alias::new("external_id"),
        )
        .expr_as(
            Expr::col((m(), mappings::Column::InternalEntityId)),
            Alias::new("internal_id"),
        )
        .from_as(mappings::Entity, m());
    let record = join_record(&mut select, inbound);
    let has_baseline = Query::select()
        .expr(Expr::val(1))
        .from_as(mappings::Entity, b())
        .cond_where(baseline_of_mapping(baseline))
        .to_owned();
    select
        .cond_where(
            done_mappings(connection_id, inbound)
                .add(record.deleted_at.is_null())
                .add(Expr::exists(has_baseline).not()),
        )
        .limit(u64::try_from(limit).unwrap_or(0));
    select
}

/// `$n::timestamp` of `moneybirdTwoWay.since` (an ISO time), as Postgres
/// casts it.
fn since_at(since: &str) -> Result<PrimitiveDateTime, DbErr> {
    crate::js::date_parse(since)
        .map(super::at_millis)
        .ok_or_else(|| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{since}\""
            ))
        })
}

/// A bill imported from any connector stays that connector's: `not exists
/// (select 1 from integration_entity_mappings x where x.internal_entity_id =
/// t.id and x.connection_id <> $1 and x.external_entity_type not like
/// 'moneybird_baseline_%')`, as `t.id not in (this)`.
fn imported_elsewhere(connection_id: &str) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let x = || Alias::new("x");
    Query::select()
        .column((x(), mappings::Column::InternalEntityId))
        .from_as(mappings::Entity, x())
        .and_where(Expr::col((x(), mappings::Column::ConnectionId)).ne(connection_id))
        .and_where(
            Expr::col((x(), mappings::Column::ExternalEntityType)).not_like("moneybird_baseline_%"),
        )
        .to_owned()
}

/// WeldBooks records made after `since` that Moneybird doesn't have yet:
/// accounting contacts, products, and bills once approved. None of them
/// mapped to this type on the connection, claimed, or failed and waiting
/// for its retry ([`super::blocking_rows`]).
async fn new_records(
    db: &PgPool,
    connection_id: &str,
    inbound: &str,
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, DbErr> {
    let since = since_at(since)?;
    let claimed = super::blocking_rows(connection_id, inbound, cutoffs(force));
    let limit = u64::try_from(limit).unwrap_or(0);
    let db = &orm(db);
    match inbound {
        MB_CONTACT_TYPE => {
            parties::Entity::find()
                .select_only()
                .column(parties::Column::Id)
                .filter(parties::Column::DeletedAt.is_null())
                .filter(parties::Column::ArchivedAt.is_null())
                .filter(parties::Column::Role.is_in(["customer", "supplier", "both"]))
                .filter(parties::Column::CreatedAt.gte(since))
                .filter(parties::Column::Id.not_in_subquery(claimed))
                .order_by_asc(parties::Column::CreatedAt)
                .limit(limit)
                .into_tuple()
                .all(db)
                .await
        }
        PRODUCT_TYPE => {
            products::Entity::find()
                .select_only()
                .column(products::Column::Id)
                .filter(products::Column::DeletedAt.is_null())
                .filter(products::Column::CreatedAt.gte(since))
                .filter(products::Column::Id.not_in_subquery(claimed))
                .order_by_asc(products::Column::CreatedAt)
                .limit(limit)
                .into_tuple()
                .all(db)
                .await
        }
        _ => {
            bills::Entity::find()
                .select_only()
                .column(bills::Column::Id)
                .filter(bills::Column::DeletedAt.is_null())
                .filter(bills::Column::Status.is_in(BILL_PUSHABLE))
                .filter(bills::Column::Id.not_in_subquery(imported_elsewhere(connection_id)))
                .filter(bills::Column::CreatedAt.gte(since))
                .filter(bills::Column::Id.not_in_subquery(claimed))
                .order_by_asc(bills::Column::CreatedAt)
                .limit(limit)
                .into_tuple()
                .all(db)
                .await
        }
    }
}

/// WeldBooks invoices made after `since` and sent, for the parent's
/// `push_invoice` (Moneybird external sales invoices): not claimed as one
/// yet, and not mapped to anything else (`not exists (select 1 from
/// integration_entity_mappings x where x.internal_entity_id = t.id and
/// x.internal_entity_type = 'invoice' and x.external_entity_type <> $2 and
/// x.external_entity_type not like 'moneybird_baseline_%')`).
pub(super) async fn new_invoice_ids(
    db: &PgPool,
    connection_id: &str,
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    let since = since_at(since)?;
    let x = || Alias::new("x");
    let mapped_elsewhere = Query::select()
        .column((x(), mappings::Column::InternalEntityId))
        .from_as(mappings::Entity, x())
        .and_where(Expr::col((x(), mappings::Column::InternalEntityType)).eq("invoice"))
        .and_where(Expr::col((x(), mappings::Column::ExternalEntityType)).ne(MB_INVOICE_TYPE))
        .and_where(
            Expr::col((x(), mappings::Column::ExternalEntityType)).not_like("moneybird_baseline_%"),
        )
        .to_owned();
    invoices::Entity::find()
        .select_only()
        .column(invoices::Column::Id)
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::Type.eq("standard"))
        .filter(invoices::Column::Status.is_in(super::PUSHABLE_STATUSES))
        .filter(invoices::Column::CreatedAt.gte(since))
        .filter(invoices::Column::Id.not_in_subquery(super::blocking_rows(
            connection_id,
            MB_INVOICE_TYPE,
            cutoffs(force),
        )))
        .filter(invoices::Column::Id.not_in_subquery(mapped_elsewhere))
        .order_by_asc(invoices::Column::CreatedAt)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple()
        .all(&orm(db))
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

/// What [`new_payments`] reads of a payment and its document.
#[derive(FromQueryResult)]
struct NewPaymentRow {
    payment_id: String,
    amount: String,
    date: PrimitiveDateTime,
    bank_transaction_id: Option<String>,
    document: String,
    kind: String,
}

/// WeldBooks payments made after `since`, allocated to (or on) a document
/// Moneybird has: `payments p left join payment_allocations a` (live
/// allocations), joined to the document's mapping `d`. Not a Stripe
/// invoice's (its payments travel with the Stripe push), and not sent to
/// that document yet, claimed, or failed and waiting for its retry.
async fn new_payments(
    db: &PgPool,
    connection_id: &str,
    types: &[&str],
    since: &str,
    force: bool,
    limit: i64,
) -> Result<Vec<PaymentRow>, DbErr> {
    let select = new_payments_query(
        connection_id,
        types,
        since_at(since)?,
        cutoffs(force),
        limit,
    );
    let rows = NewPaymentRow::find_by_statement(DbBackend::Postgres.build(&select))
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(PaymentRow {
                base: base_of(&row.kind)?,
                payment_id: row.payment_id,
                amount: row.amount,
                // As `to_jsonb` and `js_row` handed it on: `toISOString()`.
                date: Some(weldsuite_events::iso_timestamp(row.date.assume_utc())),
                bank_transaction_id: row.bank_transaction_id.filter(|b| !b.is_empty()),
                document: row.document,
            })
        })
        .collect())
}

/// [`new_payments`]' statement.
fn new_payments_query(
    connection_id: &str,
    types: &[&str],
    since: PrimitiveDateTime,
    (stale, retry): (PrimitiveDateTime, PrimitiveDateTime),
    limit: i64,
) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let (pay, alloc, doc) = (|| Alias::new("p"), || Alias::new("a"), || Alias::new("d"));
    let (stripe, sent) = (|| Alias::new("s"), || Alias::new("x"));
    let document = || Expr::col((doc(), mappings::Column::ExternalEntityId));
    let pushed = Query::select()
        .expr(Expr::val(1))
        .from_as(mappings::Entity, sent())
        .cond_where(
            Condition::all()
                .add(Expr::col((sent(), mappings::Column::ConnectionId)).eq(connection_id))
                .add(Expr::col((sent(), mappings::Column::ExternalEntityType)).eq(PAYMENT_TYPE))
                .add(
                    Expr::col((sent(), mappings::Column::InternalEntityId))
                        .equals((pay(), payments::Column::Id)),
                )
                .add(payment_claim(&sent(), &document(), stale, retry)),
        )
        .to_owned();
    let from_stripe = Query::select()
        .expr(Expr::val(1))
        .from_as(mappings::Entity, stripe())
        .and_where(
            Expr::col((stripe(), mappings::Column::InternalEntityId))
                .equals((doc(), mappings::Column::InternalEntityId)),
        )
        .and_where(
            Expr::col((stripe(), mappings::Column::ExternalEntityType)).eq(STRIPE_INVOICE_TYPE),
        )
        .to_owned();
    let mut select = Query::select();
    select
        .expr_as(
            Expr::col((pay(), payments::Column::Id)),
            Alias::new("payment_id"),
        )
        .expr_as(
            Expr::from(Func::coalesce([
                Expr::col((alloc(), payment_allocations::Column::Amount)),
                Expr::col((pay(), payments::Column::Amount)),
            ]))
            .cast_as(Alias::new("text")),
            Alias::new("amount"),
        )
        .expr_as(
            Expr::col((pay(), payments::Column::Date)),
            Alias::new("date"),
        )
        .expr_as(
            Expr::col((pay(), payments::Column::BankTransactionId)),
            Alias::new("bank_transaction_id"),
        )
        .expr_as(document(), Alias::new("document"))
        .expr_as(
            Expr::col((doc(), mappings::Column::ExternalEntityType)),
            Alias::new("kind"),
        )
        .from_as(payments::Entity, pay())
        .join_as(
            JoinType::LeftJoin,
            payment_allocations::Entity,
            alloc(),
            Condition::all()
                .add(
                    Expr::col((alloc(), payment_allocations::Column::PaymentId))
                        .equals((pay(), payments::Column::Id)),
                )
                .add(Expr::col((alloc(), payment_allocations::Column::DeletedAt)).is_null()),
        )
        .join_as(
            JoinType::InnerJoin,
            mappings::Entity,
            doc(),
            Condition::all()
                .add(Expr::col((doc(), mappings::Column::ConnectionId)).eq(connection_id))
                .add(
                    Expr::col((doc(), mappings::Column::InternalEntityId)).eq(Func::coalesce([
                        Expr::col((alloc(), payment_allocations::Column::InvoiceId)),
                        Expr::col((alloc(), payment_allocations::Column::BillId)),
                        Expr::col((pay(), payments::Column::InvoiceId)),
                        Expr::col((pay(), payments::Column::BillId)),
                    ])),
                )
                .add(
                    Expr::col((doc(), mappings::Column::ExternalEntityType))
                        .is_in(types.iter().copied()),
                )
                .add(document().not_like("pending:%"))
                .add(document().not_like("failed:%")),
        )
        .cond_where(
            Condition::all()
                .add(Expr::col((pay(), payments::Column::DeletedAt)).is_null())
                .add(Expr::col((pay(), payments::Column::CreatedAt)).gte(since))
                .add(Expr::exists(from_stripe).not())
                .add(Expr::exists(pushed).not()),
        )
        .order_by((pay(), payments::Column::CreatedAt), Order::Asc)
        .limit(u64::try_from(limit).unwrap_or(0));
    select
}

/// The payment mapping `x` holds `document`'s payment: `x.external_entity_id
/// like d.external_entity_id || ':%'`, or a claim (`pending:<document>:…`)
/// newer than `stale`, or a failure (`failed:<document>:…`) newer than
/// `retry`.
fn payment_claim(
    x: &Alias,
    document: &Expr,
    stale: PrimitiveDateTime,
    retry: PrimitiveDateTime,
) -> Condition {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr as _;
    let external = || Expr::col((x.clone(), mappings::Column::ExternalEntityId));
    let updated = || Expr::col((x.clone(), mappings::Column::UpdatedAt));
    let pattern = |prefix: &str| {
        let head = if prefix.is_empty() {
            document.clone()
        } else {
            Expr::val(prefix).concat(document.clone())
        };
        head.concat(":%")
    };
    Condition::any()
        .add(external().binary(BinOper::Like, pattern("")))
        .add(
            Condition::all()
                .add(external().binary(BinOper::Like, pattern("pending:")))
                .add(updated().gt(stale)),
        )
        .add(
            Condition::all()
                .add(external().binary(BinOper::Like, pattern("failed:")))
                .add(updated().gt(retry)),
        )
}

/// What [`voided_payments`] reads of a pushed payment.
#[derive(FromQueryResult)]
struct VoidedRow {
    id: String,
    external_id: String,
    kind: String,
}

/// Pushed payments whose WeldBooks payment was voided: (mapping row id,
/// Moneybird document id, Moneybird payment id, base path).
async fn voided_payments(
    db: &PgPool,
    connection_id: &str,
    types: &[&str],
    limit: i64,
) -> Result<Vec<(String, String, String, &'static str)>, DbErr> {
    let select = voided_query(connection_id, types, limit);
    let rows = VoidedRow::find_by_statement(DbBackend::Postgres.build(&select))
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let (document, payment) = row.external_id.split_once(':')?;
            Some((
                row.id,
                document.to_owned(),
                payment.to_owned(),
                base_of(&row.kind)?,
            ))
        })
        .collect())
}

/// [`voided_payments`]' statement.
fn voided_query(connection_id: &str, types: &[&str], limit: i64) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let (x, p, d) = (|| Alias::new("x"), || Alias::new("p"), || Alias::new("d"));
    let external = || Expr::col((x(), mappings::Column::ExternalEntityId));
    let mut select = Query::select();
    select
        .expr_as(Expr::col((x(), mappings::Column::Id)), Alias::new("id"))
        .expr_as(external(), Alias::new("external_id"))
        .expr_as(
            Expr::col((d(), mappings::Column::ExternalEntityType)),
            Alias::new("kind"),
        )
        .from_as(mappings::Entity, x())
        .join_as(
            JoinType::InnerJoin,
            payments::Entity,
            p(),
            Expr::col((p(), payments::Column::Id))
                .equals((x(), mappings::Column::InternalEntityId)),
        )
        .join_as(
            JoinType::InnerJoin,
            mappings::Entity,
            d(),
            Condition::all()
                .add(
                    Expr::col((d(), mappings::Column::ConnectionId))
                        .equals((x(), mappings::Column::ConnectionId)),
                )
                // `split_part(x.external_entity_id, ':', 1)`: the document.
                .add(
                    Expr::col((d(), mappings::Column::ExternalEntityId)).eq(Func::cust(
                        "split_part",
                    )
                    .arg(external())
                    .arg(":")
                    .arg(1)),
                )
                .add(
                    Expr::col((d(), mappings::Column::ExternalEntityType))
                        .is_in(types.iter().copied()),
                ),
        )
        .cond_where(
            Condition::all()
                .add(Expr::col((x(), mappings::Column::ConnectionId)).eq(connection_id))
                .add(Expr::col((x(), mappings::Column::ExternalEntityType)).eq(PAYMENT_TYPE))
                .add(external().not_like("pending:%"))
                .add(external().not_like("failed:%"))
                .add(Expr::col((p(), payments::Column::DeletedAt)).is_not_null()),
        )
        .limit(u64::try_from(limit).unwrap_or(0));
    select
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
pub(super) async fn has_work(db: &PgPool, connection: &Value, force: bool) -> Result<bool, DbErr> {
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
async fn park(pass: &Pass<'_>, inbound: &str, candidate: &Candidate) -> Result<(), DbErr> {
    let Some(kind) = baseline_type(inbound) else {
        return Ok(());
    };
    // `now() at time zone 'utc'`, the database's clock.
    let now = || -> Expr {
        Func::cust("timezone")
            .arg("utc")
            .arg(Expr::current_timestamp())
            .into()
    };
    mappings::Entity::update_many()
        .col_expr(
            mappings::Column::LastSyncedAt,
            Func::greatest([now(), Expr::col(mappings::Column::LastSyncedAt)]).into(),
        )
        .col_expr(mappings::Column::UpdatedAt, now())
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(kind))
        .filter(mappings::Column::ExternalEntityId.eq(candidate.external_id.as_str()))
        .exec(&orm(pass.db))
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
) -> Result<(), DbErr> {
    conflicts::Entity::insert(conflicts::ActiveModel {
        id: Set(weldsuite_kit::generate_id("cnfl")),
        connection_id: Set(pass.connection_id.clone()),
        entity_type: Set(entity_type.to_owned()),
        internal_entity_id: Set(candidate.internal_id.clone()),
        external_entity_id: Set(candidate.external_id.clone()),
        conflict_type: Set("concurrent_edit".to_owned()),
        internal_data: Set(weldbooks.clone()),
        external_data: Set(remote.clone()),
        resolution: Set(match winner {
            Winner::WeldBooks => "keep_internal",
            Winner::Moneybird => "keep_external",
        }
        .to_owned()),
        resolved_at: Set(Some(utc_now())),
        resolved_by: Set(Some("system".to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&orm(pass.db))
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
) -> Result<(), DbErr> {
    if !written.is_object() {
        return Ok(());
    }
    let now = utc_now();
    mappings::Entity::update_many()
        .set(mappings::ActiveModel {
            sync_checksum: Set(Some(record_checksum(written))),
            last_synced_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(inbound))
        .filter(mappings::Column::ExternalEntityId.eq(external_id))
        .exec(&orm(pass.db))
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

async fn pushed_by_weldbooks(pass: &Pass<'_>, bill_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::Id)
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(PUSHED_BILL_TYPE))
        .filter(mappings::Column::InternalEntityId.eq(bill_id))
        .into_tuple()
        .one(&orm(pass.db))
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
        mappings::Entity::insert(mappings::ActiveModel {
            id: Set(weldsuite_kit::generate_id("iem")),
            connection_id: Set(pass.connection_id.clone()),
            external_entity_type: Set(PUSHED_BILL_TYPE.to_owned()),
            external_entity_id: Set(external_id),
            internal_entity_type: Set("bill".to_owned()),
            internal_entity_id: Set(bill_id.to_owned()),
            last_synced_at: Set(Some(utc_now())),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm(pass.db))
        .await?;
    }
    Ok(())
}

// ── payments ────────────────────────────────────────────────────────────────

async fn financial_mutation_id(
    pass: &Pass<'_>,
    bank_transaction_id: &str,
) -> Result<Option<String>, DbErr> {
    mappings::Entity::find()
        .select_only()
        .column(mappings::Column::ExternalEntityId)
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq("moneybird_financial_mutation"))
        .filter(mappings::Column::InternalEntityId.eq(bank_transaction_id))
        .into_tuple()
        .one(&orm(pass.db))
        .await
}

async fn create_payment(pass: &mut Pass<'_>, payment: &PaymentRow) -> Step<()> {
    let pending = format!("pending:{}:{}", payment.document, payment.payment_id);
    let db = &orm(pass.db);
    // A failed or stale claim for this payment and document is retried.
    mappings::Entity::delete_many()
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(PAYMENT_TYPE))
        .filter(mappings::Column::InternalEntityId.eq(payment.payment_id.as_str()))
        .filter(
            Condition::any()
                .add(
                    mappings::Column::ExternalEntityId
                        .like(format!("pending:{}:%", payment.document)),
                )
                .add(
                    mappings::Column::ExternalEntityId
                        .like(format!("failed:{}:%", payment.document)),
                ),
        )
        .exec(db)
        .await?;
    let stamp = utc_now();
    let row = weldsuite_kit::generate_id("iem");
    let inserted = mappings::Entity::insert(mappings::ActiveModel {
        id: Set(row.clone()),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        connection_id: Set(pass.connection_id.clone()),
        external_entity_type: Set(PAYMENT_TYPE.to_owned()),
        external_entity_id: Set(pending),
        internal_entity_type: Set("payment".to_owned()),
        internal_entity_id: Set(payment.payment_id.clone()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(db)
    .await?;
    if inserted == 0 {
        return Ok(());
    }
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
            let now = utc_now();
            mappings::Entity::update_many()
                .set(mappings::ActiveModel {
                    external_entity_id: Set(external),
                    last_synced_at: Set(Some(now)),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .filter(mappings::Column::Id.eq(row.as_str()))
                .exec(db)
                .await?;
            pass.updated += 1;
            Ok(())
        }
        Err(error) => {
            if error.ends_pass() {
                release_claim(pass.db, &row).await?;
            } else {
                mappings::Entity::update_many()
                    .set(mappings::ActiveModel {
                        external_entity_id: Set(format!(
                            "failed:{}:{}",
                            payment.document, payment.payment_id
                        )),
                        updated_at: Set(utc_now()),
                        ..Default::default()
                    })
                    .filter(mappings::Column::Id.eq(row.as_str()))
                    .exec(db)
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
