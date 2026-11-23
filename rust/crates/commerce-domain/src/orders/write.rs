//! The only way an order and its items are created or changed (ADR COM-010).
//!
//! Every function runs on the caller's connection, normally inside the
//! caller's transaction: the order, its items, the number taken from the
//! settings and a discount's redemption and counter then commit or roll back
//! together. The functions publish nothing; the caller publishes the entity
//! event after the commit.
//!
//! - [`create`]: a manual order. Numbered from the settings, priced from the
//!   catalogue, VAT from the WeldBooks engine ([`crate::vat`], ADR COM-014),
//!   the discount code redeemed, safe to retry with an idempotency key.
//! - [`update`]: notes, addresses, tags and status always; the customer,
//!   shipping, items (stable item ids), buyer VAT number, price basis and
//!   the discount code only while the order is editable, with the totals, the
//!   VAT and the redemption recalculated. A change of the destination country
//!   on an editable order recalculates too.
//! - [`recalculate`]: the VAT of an editable order again, nothing else
//!   changed (after VIES came back, say). **Tax lock**: the VAT of an order
//!   that is no longer editable never changes.
//! - [`cancel`], [`mark_paid`].
//! - [`import`]: an order a store sync brought in; the store's own numbers
//!   and totals stay, the items are brought in line with the store's lines
//!   without replacing them.

use std::collections::{BTreeMap, HashSet};

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, ExprTrait, Func, Query};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::PrimitiveDateTime;
use weldsuite_books_domain::table::Table;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::orders as order_rows;
use weldsuite_schema::tenant::{
    commerce_payments, companies, discount_redemptions, discounts, order_items, parties, people,
    pick_list_items,
};

use crate::db;
use crate::error::{Error, LineProblem};
use crate::money::{self, Cents};
use crate::numbering;
use crate::orders::lines::{self, Line, LineInput};
use crate::orders::plan::{self, Plan};
use crate::orders::{self, Stored};
use crate::status;
use crate::tables::{ORDER_ITEMS, ORDERS};
use crate::totals;
use crate::vat::{self, Buyer, Taxation, VatLine};

fn put(values: &mut Map<String, Value>, table: &Table, prop: &str, value: Value) {
    debug_assert!(table.column(prop).is_some(), "{} has no {prop}", table.name);
    table.set(values, prop, value);
}

fn amount(cents: Cents) -> Value {
    json!(money::format(cents))
}

/// A tri-state field as a column value: set, cleared, or left out.
fn apply<T: Into<Value> + Clone>(
    values: &mut Map<String, Value>,
    table: &Table,
    prop: &str,
    field: &Field<T>,
) {
    match field {
        Field::Set(value) => put(values, table, prop, value.clone().into()),
        Field::Null => put(values, table, prop, Value::Null),
        Field::Absent => {}
    }
}

// ── the customer ────────────────────────────────────────────────────────────

/// Who buys, as the order records it.
#[derive(Debug, Default)]
struct Customer {
    counterparty_id: Option<String>,
    person_id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
}

/// The live party of the company `id` (`company`) or of the person `id`.
pub(crate) async fn find_party(
    conn: &mut PgConnection,
    company: bool,
    id: &str,
) -> Result<Option<String>, DbErr> {
    let of = if company {
        parties::Column::CompanyId
    } else {
        parties::Column::PersonId
    };
    parties::Entity::find()
        .select_only()
        .column(parties::Column::Id)
        .filter(of.eq(id))
        .filter(parties::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db::on(conn))
        .await
}

/// What a new party copies from its live company or person: the name, the
/// address and the archive date.
type PartySource = (String, Option<Value>, Option<PrimitiveDateTime>);

pub(crate) async fn party_of(
    conn: &mut PgConnection,
    company: bool,
    id: &str,
    owner: &str,
) -> Result<Option<String>, DbErr> {
    let found = find_party(conn, company, id).await?;
    if found.is_some() {
        return Ok(found);
    }
    // The wrapping party WeldCRM creates with a company or a person, made
    // here when it is not there yet (the same insert the connector ingest
    // does for a buyer).
    let source: Option<PartySource> = if company {
        companies::Entity::find_by_id(id.to_owned())
            .filter(companies::Column::DeletedAt.is_null())
            .select_only()
            .column(companies::Column::DisplayName)
            .column(companies::Column::PrimaryAddress)
            .column(companies::Column::ArchivedAt)
            .into_tuple()
            .one(&db::on(conn))
            .await?
    } else {
        people::Entity::find_by_id(id.to_owned())
            .filter(people::Column::DeletedAt.is_null())
            .select_only()
            .column(people::Column::DisplayName)
            .column(people::Column::PrimaryAddress)
            .column(people::Column::ArchivedAt)
            .into_tuple()
            .one(&db::on(conn))
            .await?
    };
    let Some((display_name, address, archived_at)) = source else {
        return Ok(None);
    };
    let now = db::now();
    let mut party = parties::ActiveModel {
        id: Set(generate_id("party")),
        kind: Set(Some(if company { "company" } else { "person" }.to_owned())),
        role: Set("customer".to_owned()),
        display_name: Set(Some(display_name)),
        billing_address: Set(address),
        archived_at: Set(archived_at),
        owner_id: Set(Some(owner.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    if company {
        party.company_id = Set(Some(id.to_owned()));
    } else {
        party.person_id = Set(Some(id.to_owned()));
    }
    Ok(Some(party.insert(&db::on(conn)).await?.id))
}

type Identity = (Option<String>, Option<String>, Option<String>);

/// A person's name, e-mail, mobile and direct phone.
type PersonIdentity = (String, Option<String>, Option<String>, Option<String>);

async fn identity(
    conn: &mut PgConnection,
    company: bool,
    id: &str,
) -> Result<Option<Identity>, DbErr> {
    if company {
        let found: Option<(String, Option<String>, Option<String>)> =
            companies::Entity::find_by_id(id.to_owned())
                .filter(companies::Column::DeletedAt.is_null())
                .select_only()
                .column(companies::Column::DisplayName)
                .column(companies::Column::Email)
                .column(companies::Column::Phone)
                .into_tuple()
                .one(&db::on(conn))
                .await?;
        return Ok(found.map(|(name, email, phone)| (Some(name), email, phone)));
    }
    let found: Option<PersonIdentity> = people::Entity::find_by_id(id.to_owned())
        .filter(people::Column::DeletedAt.is_null())
        .select_only()
        .column(people::Column::DisplayName)
        .column(people::Column::Email)
        .column(people::Column::MobilePhone)
        .column(people::Column::DirectPhone)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    Ok(found.map(|(name, email, mobile, direct)| (Some(name), email, mobile.or(direct))))
}

/// The buyer: a company (its party is the counterparty) and/or a person.
/// Without a company, the person's own party is.
async fn customer(
    conn: &mut PgConnection,
    company_id: Option<&str>,
    person_id: Option<&str>,
    owner: &str,
) -> Result<Customer, Error> {
    let mut out = Customer::default();
    let mut company = None;
    if let Some(id) = company_id {
        let found = identity(conn, true, id)
            .await?
            .ok_or_else(|| Error::invalid("companyId", "Company not found"))?;
        out.counterparty_id = party_of(conn, true, id, owner).await?;
        company = Some(found);
    }
    let mut person = None;
    if let Some(id) = person_id {
        let found = identity(conn, false, id)
            .await?
            .ok_or_else(|| Error::invalid("personId", "Person not found"))?;
        if out.counterparty_id.is_none() {
            out.counterparty_id = party_of(conn, false, id, owner).await?;
        }
        out.person_id = Some(id.to_owned());
        person = Some(found);
    }
    let first =
        |a: Option<&Identity>, b: Option<&Identity>, pick: fn(&Identity) -> &Option<String>| {
            a.and_then(|i| pick(i).clone())
                .or_else(|| b.and_then(|i| pick(i).clone()))
        };
    out.name = first(person.as_ref(), company.as_ref(), |i| &i.0);
    out.email = first(person.as_ref(), company.as_ref(), |i| &i.1);
    out.phone = first(person.as_ref(), company.as_ref(), |i| &i.2);
    Ok(out)
}

// ── redemptions ─────────────────────────────────────────────────────────────

async fn redeem(
    conn: &mut PgConnection,
    order_id: &str,
    redeemed: &plan::Redeemed,
    person_id: Option<&str>,
    email: Option<&str>,
    currency: &str,
) -> Result<(), DbErr> {
    discount_redemptions::ActiveModel {
        id: Set(generate_id("dred")),
        discount_id: Set(redeemed.id.clone()),
        order_id: Set(order_id.to_owned()),
        person_id: Set(person_id.map(str::to_owned)),
        customer_email: Set(email.map(str::to_owned)),
        amount: Set(db::decimal(redeemed.amount)),
        currency: Set(Some(currency.to_owned())),
        ..Default::default()
    }
    .insert(&db::on(conn))
    .await?;
    discounts::Entity::update_many()
        .col_expr(
            discounts::Column::UsageCount,
            usage_count().add(Expr::val(1)),
        )
        .filter(discounts::Column::Id.eq(redeemed.id.as_str()))
        .exec(&db::on(conn))
        .await?;
    Ok(())
}

/// `coalesce(usage_count, 0)` of a discount.
fn usage_count() -> Expr {
    Func::coalesce([
        Expr::col((discounts::Entity, discounts::Column::UsageCount)),
        Expr::val(0),
    ])
    .into()
}

/// Give back the order's redemptions: the rows go and the counters drop.
async fn release(conn: &mut PgConnection, order_id: &str) -> Result<(), DbErr> {
    let gone = discount_redemptions::Entity::delete_many()
        .filter(discount_redemptions::Column::OrderId.eq(order_id))
        .exec_with_returning(&db::on(conn))
        .await?;
    let mut uses: BTreeMap<String, i32> = BTreeMap::new();
    for redemption in gone {
        *uses.entry(redemption.discount_id).or_default() += 1;
    }
    for (discount_id, n) in uses {
        discounts::Entity::update_many()
            .col_expr(
                discounts::Column::UsageCount,
                Func::greatest([usage_count().sub(Expr::val(n)), Expr::val(0)]).into(),
            )
            .filter(discounts::Column::Id.eq(discount_id))
            .exec(&db::on(conn))
            .await?;
    }
    Ok(())
}

/// Bring the order's redemption in line with `redeemed`.
async fn sync_redemption(
    conn: &mut PgConnection,
    order_id: &str,
    redeemed: Option<&plan::Redeemed>,
    person_id: Option<&str>,
    email: Option<&str>,
    currency: &str,
) -> Result<(), DbErr> {
    let current: Option<String> = discount_redemptions::Entity::find()
        .select_only()
        .column(discount_redemptions::Column::DiscountId)
        .filter(discount_redemptions::Column::OrderId.eq(order_id))
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    match (current.as_deref(), redeemed) {
        (Some(have), Some(want)) if have == want.id => {
            discount_redemptions::Entity::update_many()
                .col_expr(
                    discount_redemptions::Column::Amount,
                    Expr::value(db::decimal(want.amount)),
                )
                .col_expr(
                    discount_redemptions::Column::PersonId,
                    Expr::value(person_id.map(str::to_owned)),
                )
                .col_expr(
                    discount_redemptions::Column::CustomerEmail,
                    Expr::value(email.map(str::to_owned)),
                )
                .col_expr(
                    discount_redemptions::Column::Currency,
                    Expr::value(currency.to_owned()),
                )
                .filter(discount_redemptions::Column::OrderId.eq(order_id))
                .filter(discount_redemptions::Column::DiscountId.eq(want.id.as_str()))
                .exec(&db::on(conn))
                .await?;
        }
        (have, want) => {
            if have.is_some() {
                release(conn, order_id).await?;
            }
            if let Some(want) = want {
                redeem(conn, order_id, want, person_id, email, currency).await?;
            }
        }
    }
    Ok(())
}

// ── items ───────────────────────────────────────────────────────────────────

fn item_values(
    order_id: &str,
    line: &Line,
    amounts: (Cents, Cents, &VatLine),
    properties: Value,
    now: &str,
) -> Map<String, Value> {
    let (discount, total, vat) = amounts;
    let t = &ORDER_ITEMS;
    let mut values = Map::new();
    put(&mut values, t, "orderId", json!(order_id));
    put(&mut values, t, "productId", json!(line.product_id));
    put(&mut values, t, "variantId", json!(line.variant_id));
    put(&mut values, t, "sku", json!(line.sku));
    put(&mut values, t, "name", json!(line.name));
    put(&mut values, t, "imageUrl", json!(line.image_url));
    put(&mut values, t, "quantity", json!(line.quantity));
    put(&mut values, t, "unitPrice", amount(line.unit_price));
    put(&mut values, t, "discountAmount", amount(discount));
    put(&mut values, t, "taxAmount", amount(vat.tax));
    put(
        &mut values,
        t,
        "taxRate",
        json!(vat::rate_percent(vat.rate_bps)),
    );
    put(&mut values, t, "vatCategory", json!(vat.category));
    put(&mut values, t, "total", amount(total));
    put(&mut values, t, "properties", properties);
    put(&mut values, t, "updatedAt", json!(now));
    values
}

async fn insert_item(
    conn: &mut PgConnection,
    order_id: &str,
    line: &Line,
    amounts: (Cents, Cents, &VatLine),
    now: &str,
) -> Result<(), DbErr> {
    let properties = lines::properties(None, line.variant_name.as_deref());
    let mut values = item_values(order_id, line, amounts, properties, now);
    put(&mut values, &ORDER_ITEMS, "id", json!(generate_id("oitm")));
    put(&mut values, &ORDER_ITEMS, "createdAt", json!(now));
    ORDER_ITEMS
        .insert_raw(&mut *conn, values)
        .await?;
    Ok(())
}

/// Delete the items among `ids` that nothing was fulfilled from and no pick
/// list holds; the ids that went.
async fn delete_free_items(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<String>, DbErr> {
    let picked = Query::select()
        .expr(Expr::val(1))
        .from(pick_list_items::Entity)
        .and_where(
            Expr::col((
                pick_list_items::Entity,
                pick_list_items::Column::OrderItemId,
            ))
            .equals((order_items::Entity, order_items::Column::Id)),
        )
        .to_owned();
    let gone = order_items::Entity::delete_many()
        .filter(order_items::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(
            Func::coalesce([
                Expr::col((order_items::Entity, order_items::Column::FulfilledQuantity)),
                Expr::val(0),
            ])
            .eq(Expr::val(0)),
        )
        .filter(Expr::not_exists(picked))
        .exec_with_returning(&db::on(conn))
        .await?;
    Ok(gone.into_iter().map(|item| item.id).collect())
}

fn line_problems(resolved: &[Line]) -> Result<(), Error> {
    let problems: Vec<LineProblem> = resolved
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.problem.map(|problem| LineProblem { index, problem }))
        .collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(Error::LineProblems(problems))
    }
}

/// The header columns an order's amounts and discount decide.
fn plan_values(values: &mut Map<String, Value>, plan: &Plan, lines: &[Line], metadata: &Value) {
    let t = &ORDERS;
    if let Some(vat) = &plan.vat {
        put(values, t, "pricesIncludeTax", json!(vat.prices_include_tax));
        put(values, t, "vatTreatment", json!(vat.treatment));
        put(
            values,
            t,
            "destinationCountry",
            json!(vat.destination_country),
        );
        put(values, t, "buyerVatNumber", json!(vat.buyer_vat_number));
        put(values, t, "taxLines", vat.tax_lines_json());
    }
    put(values, t, "subtotal", amount(plan.totals.subtotal));
    put(
        values,
        t,
        "discountTotal",
        amount(plan.totals.discount_total),
    );
    put(
        values,
        t,
        "shippingTotal",
        amount(plan.totals.shipping_total),
    );
    put(values, t, "taxTotal", amount(plan.totals.tax_total));
    put(values, t, "total", amount(plan.totals.total));
    let quantities: Vec<i64> = lines.iter().map(|l| l.quantity).collect();
    let (item_count, total_quantity) = totals::counts(&quantities);
    put(values, t, "itemCount", json!(item_count));
    put(values, t, "totalQuantity", json!(total_quantity));
    put(
        values,
        t,
        "discountCode",
        plan.discount
            .as_ref()
            .map_or(Value::Null, |d| json!(d.code)),
    );
    put(
        values,
        t,
        "discountId",
        plan.discount.as_ref().map_or(Value::Null, |d| json!(d.id)),
    );
    let mut metadata = metadata.as_object().cloned().unwrap_or_default();
    metadata.insert(
        "shippingRequested".to_owned(),
        amount(plan.shipping_requested),
    );
    match plan
        .discount
        .as_ref()
        .map(|d| d.shipping_waived)
        .filter(|w| *w > 0)
    {
        Some(waived) => metadata.insert("shippingDiscount".to_owned(), amount(waived)),
        None => metadata.remove("shippingDiscount"),
    };
    vat_metadata(&mut metadata, plan.vat.as_ref());
    put(values, t, "metadata", Value::Object(metadata));
}

/// The VAT facts that have no column: the VIES flag, shipping's own VAT (an
/// order's shipping is one amount, taxed as a line of its own), and the VAT
/// a zero-rated sale took off VAT-inclusive prices.
fn vat_metadata(metadata: &mut Map<String, Value>, vat: Option<&vat::Vat>) {
    let Some(vat) = vat else {
        return;
    };
    if vat.vies_unavailable {
        metadata.insert("viesUnavailable".to_owned(), json!(true));
    } else {
        metadata.remove("viesUnavailable");
    }
    match &vat.shipping {
        Some(shipping) => metadata.insert(
            "shippingVat".to_owned(),
            json!({
                "rate": vat::rate_percent(shipping.rate_bps),
                "net": money::format(shipping.net),
                "tax": money::format(shipping.tax),
                "gross": money::format(shipping.gross),
            }),
        ),
        None => metadata.remove("shippingVat"),
    };
    if vat.vat_relief > 0 {
        metadata.insert("vatRelief".to_owned(), amount(vat.vat_relief));
    } else {
        metadata.remove("vatRelief");
    }
}

/// What a stored order records of its buyer for VAT: the price basis, the
/// shipping and billing countries and the VAT number.
struct StoredBuyer {
    prices_include_tax: bool,
    shipping_country: Option<String>,
    billing_country: Option<String>,
    vat_number: Option<String>,
}

fn stored_buyer(order: &Value) -> StoredBuyer {
    StoredBuyer {
        prices_include_tax: order
            .get("pricesIncludeTax")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        shipping_country: vat::country_of(order.get("shippingAddress")),
        billing_country: vat::country_of(order.get("billingAddress")),
        vat_number: order
            .get("buyerVatNumber")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
    }
}

// ── create ──────────────────────────────────────────────────────────────────

/// A manual order.
#[derive(Debug, Clone, Default)]
pub struct NewOrder {
    /// `manual` for staff-entered orders.
    pub source: String,
    pub channel_id: Option<String>,
    pub currency: String,
    pub company_id: Option<String>,
    pub person_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_email: Option<String>,
    pub customer_phone: Option<String>,
    pub lines: Vec<LineInput>,
    pub discount_code: Option<String>,
    pub shipping: Cents,
    pub billing_address: Option<Value>,
    pub shipping_address: Option<Value>,
    pub customer_reference: Option<String>,
    pub customer_note: Option<String>,
    pub internal_note: Option<String>,
    /// The prices on the order include VAT (catalogue prices do).
    pub prices_include_tax: bool,
    /// The buyer's VAT number, as typed; VIES checks it for a sale to
    /// another EU country.
    pub buyer_vat_number: Option<String>,
    /// `pending` or `confirmed`.
    pub status: String,
    pub tags: Vec<String>,
    pub created_by: String,
    /// A client key that makes a retry return the first order.
    pub idempotency_key: Option<String>,
}

/// The order that was placed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub id: String,
    pub order_number: String,
    /// The idempotency key had placed this order already; nothing was written.
    pub replayed: bool,
}

/// Place an order.
///
/// # Errors
/// [`Error::Invalid`] for a company or person that is gone,
/// [`Error::LineProblems`] for lines the catalogue cannot price,
/// [`Error::Discount`] for a code that does not apply, and the VAT refusals
/// ([`Error::SellerEntityRequired`], [`Error::SellerNotEu`],
/// [`Error::TaxEngineUnavailable`]): nothing is written then.
#[allow(
    clippy::too_many_lines,
    reason = "the order, then its items, then the redemption"
)]
pub async fn create(
    conn: &mut PgConnection,
    tax: &Taxation<'_>,
    new: &NewOrder,
) -> Result<Created, Error> {
    if let Some(key) = &new.idempotency_key {
        db::advisory_lock(conn, &format!("weldcommerce:order-key:{key}")).await?;
        let found: Option<(String, String)> = order_rows::Entity::find()
            .select_only()
            .column(order_rows::Column::Id)
            .column(order_rows::Column::OrderNumber)
            .filter(order_rows::Column::IdempotencyKey.eq(key.as_str()))
            .into_tuple()
            .one(&db::on(conn))
            .await?;
        if let Some((id, order_number)) = found {
            return Ok(Created {
                id,
                order_number,
                replayed: true,
            });
        }
    }
    let buyer = customer(
        conn,
        new.company_id.as_deref(),
        new.person_id.as_deref(),
        &new.created_by,
    )
    .await?;
    let resolved = lines::resolve(conn, &new.currency, &new.lines, &[]).await?;
    line_problems(&resolved)?;
    let email = new.customer_email.clone().or_else(|| buyer.email.clone());
    let shipping_country = vat::country_of(new.shipping_address.as_ref());
    let billing_country = vat::country_of(new.billing_address.as_ref());
    let plan = plan::price(
        conn,
        tax,
        &plan::Input {
            currency: &new.currency,
            lines: &resolved,
            discount_code: new.discount_code.as_deref(),
            keep_discount_id: None,
            shipping: new.shipping,
            person_id: buyer.person_id.as_deref(),
            counterparty_id: buyer.counterparty_id.as_deref(),
            email: email.as_deref(),
            order_id: None,
            lock: true,
        },
        &Buyer {
            prices_include_tax: new.prices_include_tax,
            shipping_country: shipping_country.as_deref(),
            billing_country: billing_country.as_deref(),
            vat_number: new.buyer_vat_number.as_deref(),
        },
    )
    .await?;
    if let Some(problem) = plan.discount_problem {
        return Err(Error::Discount(problem));
    }
    let order_number = numbering::take(conn, &new.source).await?;
    let id = generate_id("ord");
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "id", json!(id));
    put(&mut values, t, "orderNumber", json!(order_number));
    put(&mut values, t, "source", json!(new.source));
    put(&mut values, t, "channelId", json!(new.channel_id));
    put(&mut values, t, "status", json!(new.status));
    put(&mut values, t, "paymentStatus", json!("pending"));
    put(&mut values, t, "currency", json!(new.currency));
    put(
        &mut values,
        t,
        "counterpartyId",
        json!(buyer.counterparty_id),
    );
    put(&mut values, t, "personId", json!(buyer.person_id));
    put(
        &mut values,
        t,
        "customerName",
        json!(new.customer_name.clone().or(buyer.name)),
    );
    put(&mut values, t, "customerEmail", json!(email));
    put(
        &mut values,
        t,
        "customerPhone",
        json!(new.customer_phone.clone().or(buyer.phone)),
    );
    put(&mut values, t, "billingAddress", json!(new.billing_address));
    put(
        &mut values,
        t,
        "shippingAddress",
        json!(new.shipping_address),
    );
    put(
        &mut values,
        t,
        "customerReference",
        json!(new.customer_reference),
    );
    put(&mut values, t, "customerNote", json!(new.customer_note));
    put(&mut values, t, "internalNote", json!(new.internal_note));
    put(&mut values, t, "tags", json!(new.tags));
    put(&mut values, t, "createdBy", json!(new.created_by));
    put(&mut values, t, "idempotencyKey", json!(new.idempotency_key));
    put(&mut values, t, "approvalStatus", json!("not_required"));
    put(&mut values, t, "createdAt", json!(now));
    put(&mut values, t, "updatedAt", json!(now));
    plan_values(&mut values, &plan, &resolved, &Value::Null);
    ORDERS.insert_raw(&mut *conn, values).await?;
    for (index, line) in resolved.iter().enumerate() {
        let total = plan.line_total(&resolved, index);
        let amounts = (plan.line_discounts[index], total, vat_line(&plan, index));
        insert_item(conn, &id, line, amounts, &staggered(&now, index)).await?;
    }
    if let Some(redeemed) = &plan.discount {
        redeem(
            conn,
            &id,
            redeemed,
            buyer.person_id.as_deref(),
            email.as_deref(),
            &new.currency,
        )
        .await?;
    }
    Ok(Created {
        id,
        order_number,
        replayed: false,
    })
}

// ── update ──────────────────────────────────────────────────────────────────

/// A change to an order. A field left out is left alone.
#[derive(Debug, Default)]
pub struct Patch {
    pub billing_address: Field<Value>,
    pub shipping_address: Field<Value>,
    pub customer_reference: Field<String>,
    pub customer_note: Field<String>,
    pub internal_note: Field<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
    // Only while the order is editable:
    pub company_id: Field<String>,
    pub person_id: Field<String>,
    pub customer_name: Field<String>,
    pub customer_email: Field<String>,
    pub customer_phone: Field<String>,
    pub shipping_total: Option<Cents>,
    pub discount_code: Field<String>,
    pub buyer_vat_number: Field<String>,
    pub prices_include_tax: Option<bool>,
    /// The full list: a line with an `id` updates that item, a line without
    /// one is added, an item that is not listed is removed.
    pub items: Option<Vec<LineInput>>,
}

/// What an update did, for the events the caller publishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Updated {
    /// The status moved to `completed`.
    pub completed: bool,
}

fn differs(field: &Field<String>, current: Option<&str>) -> bool {
    match field {
        Field::Absent => false,
        Field::Null => current.is_some_and(|c| !c.is_empty()),
        Field::Set(value) => current != Some(value.as_str()),
    }
}

fn requested_shipping(order: &Value) -> Cents {
    order
        .pointer("/metadata/shippingRequested")
        .and_then(Value::as_str)
        .or_else(|| order.get("shippingTotal").and_then(Value::as_str))
        .and_then(money::parse)
        .unwrap_or(0)
}

async fn company_of(
    conn: &mut PgConnection,
    counterparty: Option<&str>,
) -> Result<Option<String>, DbErr> {
    let Some(party) = counterparty else {
        return Ok(None);
    };
    let found: Option<Option<String>> = parties::Entity::find_by_id(party.to_owned())
        .select_only()
        .column(parties::Column::CompanyId)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    Ok(found.flatten())
}

/// What an edit of an editable order touches.
#[allow(clippy::struct_excessive_bools, reason = "one flag per kind of edit")]
struct Edits {
    customer: bool,
    shipping: bool,
    discount: bool,
    items: bool,
    /// The VAT's facts changed: the destination country, the buyer's VAT
    /// number or the price basis.
    tax: bool,
}

impl Edits {
    fn any(&self) -> bool {
        self.customer || self.shipping || self.discount || self.items || self.tax
    }
}

/// An address field after a patch: what it sets, clears or leaves.
fn merged_address(field: &Field<Value>, stored: Option<&Value>) -> Option<Value> {
    match field {
        Field::Set(address) => Some(address.clone()),
        Field::Null => None,
        Field::Absent => stored.filter(|a| !a.is_null()).cloned(),
    }
}

fn merged_text(field: &Field<String>, stored: Option<String>) -> Option<String> {
    match field {
        Field::Set(text) => Some(text.clone()),
        Field::Null => None,
        Field::Absent => stored,
    }
}

fn destination(shipping: Option<&Value>, billing: Option<&Value>) -> Option<String> {
    vat::country_of(shipping).or_else(|| vat::country_of(billing))
}

fn tax_facts_changed(stored: &Stored, patch: &Patch) -> bool {
    let order = &stored.order;
    let before = destination(order.get("shippingAddress"), order.get("billingAddress"));
    let after = destination(
        merged_address(&patch.shipping_address, order.get("shippingAddress")).as_ref(),
        merged_address(&patch.billing_address, order.get("billingAddress")).as_ref(),
    );
    // The stored destination is the effective one (an order with no address
    // is taxed as a domestic sale), so a first address in that same country
    // changes nothing.
    let country_changed = match (&after, &before) {
        (Some(country), _) => stored.text("destinationCountry") != Some(country.as_str()),
        (None, Some(_)) => true,
        (None, None) => false,
    };
    let known = stored_buyer(order);
    // An address of an order that is no longer editable is just recorded:
    // its tax stays (the lock), so the country alone is no edit there.
    (country_changed && stored.editable())
        || patch
            .prices_include_tax
            .is_some_and(|p| p != known.prices_include_tax)
        || differs(&patch.buyer_vat_number, known.vat_number.as_deref())
}

fn detect(stored: &Stored, patch: &Patch, company: Option<&str>) -> Edits {
    let order = &stored.order;
    let customer = differs(&patch.person_id, stored.text("personId"))
        || differs(&patch.company_id, company)
        || differs(&patch.customer_name, stored.text("customerName"))
        || differs(&patch.customer_email, stored.text("customerEmail"))
        || differs(&patch.customer_phone, stored.text("customerPhone"));
    let shipping = patch
        .shipping_total
        .is_some_and(|typed| typed != requested_shipping(order));
    let stored_code = stored
        .text("discountCode")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let discount = match &patch.discount_code {
        Field::Absent => false,
        Field::Null => !stored_code.is_empty(),
        Field::Set(code) => code.trim().to_lowercase() != stored_code,
    };
    Edits {
        customer,
        shipping,
        discount,
        items: patch.items.is_some(),
        tax: tax_facts_changed(stored, patch),
    }
}

fn not_editable(stored: &Stored) -> Error {
    let reason = if stored
        .text("externalOrderId")
        .is_some_and(|id| !id.is_empty())
    {
        "The order is synced from a store; change it there"
    } else {
        "The order can no longer be edited: it is cancelled, completed, paid or partly fulfilled"
    };
    Error::NotEditable(reason.to_owned())
}

fn check_item_ids(stored: &Stored, inputs: &[LineInput]) -> Result<(), Error> {
    let have: HashSet<&str> = stored
        .items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect();
    let mut seen = HashSet::new();
    for (index, input) in inputs.iter().enumerate() {
        if let Some(id) = &input.id
            && (!have.contains(id.as_str()) || !seen.insert(id.as_str()))
        {
            return Err(Error::invalid(
                format!("items.{index}.id"),
                "Not an item of this order, or listed twice",
            ));
        }
    }
    Ok(())
}

/// Write the lines of an items edit: update in place, insert new, delete a
/// removed one unless a pick list holds it.
/// `now` plus `index` milliseconds: items are read back in creation order,
/// so the lines of one request must not share a timestamp (their ids are not
/// ordered).
fn staggered(now: &str, index: usize) -> String {
    let millis = weldsuite_kit::validation::js_date_parse(now).unwrap_or(0.0);
    #[allow(clippy::cast_precision_loss)]
    let at = millis + index as f64;
    weldsuite_kit::validation::js_iso_from_millis(at).unwrap_or_else(|| now.to_owned())
}

/// The VAT of line `index` (an order priced by [`plan::price`] has one).
fn vat_line(plan: &Plan, index: usize) -> &VatLine {
    static NONE: VatLine = VatLine {
        category: "standard",
        rate_bps: 0,
        net: 0,
        tax: 0,
        gross: 0,
    };
    plan.vat
        .as_ref()
        .and_then(|vat| vat.lines.get(index))
        .unwrap_or(&NONE)
}

async fn write_items(
    conn: &mut PgConnection,
    stored: &Stored,
    resolved: &[Line],
    plan: &Plan,
    now: &str,
) -> Result<(), Error> {
    let order_id = stored.text("id").unwrap_or_default();
    let listed: HashSet<&str> = resolved.iter().filter_map(|l| l.id.as_deref()).collect();
    let removed: Vec<String> = stored
        .items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .filter(|id| !listed.contains(id))
        .map(str::to_owned)
        .collect();
    if !removed.is_empty() {
        let gone = delete_free_items(conn, &removed).await?;
        if gone.len() != removed.len() {
            return Err(Error::NotEditable(
                "An item that is on a pick list cannot be removed".to_owned(),
            ));
        }
    }
    for (index, line) in resolved.iter().enumerate() {
        let total = plan.line_total(resolved, index);
        let discount = plan.line_discounts[index];
        let amounts = (discount, total, vat_line(plan, index));
        if let Some(id) = &line.id {
            let existing = stored
                .items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()));
            let properties = lines::properties(
                existing.and_then(|item| item.get("properties")),
                line.variant_name.as_deref(),
            );
            let values = item_values(order_id, line, amounts, properties, now);
            ORDER_ITEMS.patch_raw(&mut *conn, id, values, false).await?;
        } else {
            insert_item(conn, order_id, line, amounts, &staggered(now, index)).await?;
        }
    }
    Ok(())
}

/// Change an order.
///
/// # Errors
/// [`Error::NotFound`]; [`Error::NotEditable`] when the customer, shipping,
/// discount code or items change on an order that is not editable;
/// [`Error::InvalidTransition`] for a status that moves backwards or is
/// `cancelled`; [`Error::LineProblems`], [`Error::Discount`] and
/// [`Error::Invalid`] as for [`create`].
#[allow(
    clippy::too_many_lines,
    reason = "one pass over what the patch touches"
)]
pub async fn update(
    conn: &mut PgConnection,
    tax: &Taxation<'_>,
    id: &str,
    patch: &Patch,
) -> Result<Updated, Error> {
    let stored = orders::load(conn, id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    let order = &stored.order;
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "updatedAt", json!(now));
    apply(&mut values, t, "billingAddress", &patch.billing_address);
    apply(&mut values, t, "shippingAddress", &patch.shipping_address);
    apply(
        &mut values,
        t,
        "customerReference",
        &patch.customer_reference,
    );
    apply(&mut values, t, "customerNote", &patch.customer_note);
    apply(&mut values, t, "internalNote", &patch.internal_note);
    if let Some(tags) = &patch.tags {
        put(&mut values, t, "tags", json!(tags));
    }

    let mut completed = false;
    if let Some(to) = &patch.status {
        let from = stored.text("status").unwrap_or("pending");
        if to != from {
            if stored.text("approvalStatus") == Some("pending")
                && matches!(to.as_str(), "confirmed" | "processing" | "completed")
            {
                return Err(Error::ApprovalPending);
            }
            if !status::can_move(from, to) {
                return Err(Error::InvalidTransition {
                    from: from.to_owned(),
                    to: to.clone(),
                });
            }
            put(&mut values, t, "status", json!(to));
            if to == "completed" {
                put(&mut values, t, "completedAt", json!(now));
                completed = true;
            }
        }
    }

    let company = company_of(conn, stored.text("counterpartyId")).await?;
    let edits = detect(&stored, patch, company.as_deref());
    if edits.any() {
        if !stored.editable() {
            return Err(not_editable(&stored));
        }
        ensure_no_open_payment(conn, id).await?;
        let owner = stored.text("createdBy").unwrap_or_default().to_owned();
        let mut person_id = stored.text("personId").map(str::to_owned);
        let mut email = stored.text("customerEmail").map(str::to_owned);
        let mut counterparty = stored.text("counterpartyId").map(str::to_owned);
        if edits.customer {
            let company_new = match &patch.company_id {
                Field::Set(id) => Some(id.clone()),
                Field::Null => None,
                Field::Absent => company.clone(),
            };
            let person_new = match &patch.person_id {
                Field::Set(id) => Some(id.clone()),
                Field::Null => None,
                Field::Absent => person_id.clone(),
            };
            let buyer =
                customer(conn, company_new.as_deref(), person_new.as_deref(), &owner).await?;
            counterparty = buyer.counterparty_id;
            person_id = buyer.person_id;
            put(&mut values, t, "counterpartyId", json!(counterparty));
            put(&mut values, t, "personId", json!(person_id));
            // A customer the order has no name or e-mail for lends it.
            if stored.text("customerName").is_none_or(str::is_empty)
                && patch.customer_name.is_absent()
            {
                put(&mut values, t, "customerName", json!(buyer.name));
            }
            if email.is_none() && patch.customer_email.is_absent() {
                email.clone_from(&buyer.email);
                put(&mut values, t, "customerEmail", json!(buyer.email));
            }
            if stored.text("customerPhone").is_none_or(str::is_empty)
                && patch.customer_phone.is_absent()
            {
                put(&mut values, t, "customerPhone", json!(buyer.phone));
            }
        }
        apply(&mut values, t, "customerName", &patch.customer_name);
        apply(&mut values, t, "customerPhone", &patch.customer_phone);
        if let Field::Set(address) = &patch.customer_email {
            email = Some(address.clone());
        } else if patch.customer_email == Field::Null {
            email = None;
        }
        apply(&mut values, t, "customerEmail", &patch.customer_email);

        let currency = stored.text("currency").unwrap_or("EUR").to_owned();
        let resolved: Vec<Line> = if let Some(inputs) = &patch.items {
            check_item_ids(&stored, inputs)?;
            let resolved = lines::resolve(conn, &currency, inputs, &stored.items).await?;
            line_problems(&resolved)?;
            resolved
        } else {
            stored.items.iter().map(lines::stored_line).collect()
        };
        let (code, keep) = discount_source(&stored, &patch.discount_code);
        let shipping = patch
            .shipping_total
            .unwrap_or_else(|| requested_shipping(order));
        let known = stored_buyer(order);
        let shipping_address =
            merged_address(&patch.shipping_address, order.get("shippingAddress"));
        let billing_address = merged_address(&patch.billing_address, order.get("billingAddress"));
        let shipping_country = vat::country_of(shipping_address.as_ref());
        let billing_country = vat::country_of(billing_address.as_ref());
        let vat_number = merged_text(&patch.buyer_vat_number, known.vat_number);
        let plan = plan::price(
            conn,
            tax,
            &plan::Input {
                currency: &currency,
                lines: &resolved,
                discount_code: code.as_deref(),
                keep_discount_id: keep.as_deref(),
                shipping,
                person_id: person_id.as_deref(),
                counterparty_id: counterparty.as_deref(),
                email: email.as_deref(),
                order_id: Some(id),
                lock: true,
            },
            &Buyer {
                prices_include_tax: patch.prices_include_tax.unwrap_or(known.prices_include_tax),
                shipping_country: shipping_country.as_deref(),
                billing_country: billing_country.as_deref(),
                vat_number: vat_number.as_deref(),
            },
        )
        .await?;
        if let Some(problem) = plan.discount_problem {
            return Err(Error::Discount(problem));
        }
        if patch.items.is_some() {
            write_items(conn, &stored, &resolved, &plan, &now).await?;
        } else {
            write_item_amounts(conn, &stored, &resolved, &plan, &now).await?;
        }
        plan_values(
            &mut values,
            &plan,
            &resolved,
            order.get("metadata").unwrap_or(&Value::Null),
        );
        sync_redemption(
            conn,
            id,
            plan.discount.as_ref(),
            person_id.as_deref(),
            email.as_deref(),
            &currency,
        )
        .await?;
    }
    ORDERS.patch_raw(&mut *conn, id, values, true).await?;
    Ok(Updated { completed })
}

/// The discount an edit prices with: `(code to look up, discount id to keep)`.
/// A patch that leaves the code out, or sends the one the order holds, keeps
/// the stored discount by id (no status, date or usage gates: the code may
/// have expired or been archived since it was redeemed); only a different
/// code is looked up and checked in full.
fn discount_source(stored: &Stored, field: &Field<String>) -> (Option<String>, Option<String>) {
    let held_code = stored.text("discountCode").filter(|c| !c.trim().is_empty());
    let held = stored
        .text("discountId")
        .filter(|_| held_code.is_some())
        .map(str::to_owned);
    match field {
        Field::Absent => (None, held),
        Field::Null => (None, None),
        Field::Set(code) => {
            let same =
                held_code.is_some_and(|c| c.trim().to_lowercase() == code.trim().to_lowercase());
            if same && held.is_some() {
                (None, held)
            } else {
                (Some(code.clone()), None)
            }
        }
    }
}

/// Write each item's discount, VAT and total after the order was re-priced
/// without changing its items.
async fn write_item_amounts(
    conn: &mut PgConnection,
    stored: &Stored,
    resolved: &[Line],
    plan: &Plan,
    now: &str,
) -> Result<(), Error> {
    for (index, item) in stored.items.iter().enumerate() {
        let Some(item_id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let vat = vat_line(plan, index);
        let mut change = Map::new();
        let t = &ORDER_ITEMS;
        put(
            &mut change,
            t,
            "discountAmount",
            amount(plan.line_discounts[index]),
        );
        put(&mut change, t, "taxAmount", amount(vat.tax));
        put(
            &mut change,
            t,
            "taxRate",
            json!(vat::rate_percent(vat.rate_bps)),
        );
        put(&mut change, t, "vatCategory", json!(vat.category));
        put(
            &mut change,
            t,
            "total",
            amount(plan.line_total(resolved, index)),
        );
        put(&mut change, t, "updatedAt", json!(now));
        ORDER_ITEMS
            .patch_raw(&mut *conn, item_id, change, false)
            .await?;
    }
    Ok(())
}

/// Work the VAT of an editable order out again, nothing else changed (after
/// VIES came back, or the seller's OSS registration was added).
///
/// # Errors
/// [`Error::NotFound`]; [`Error::TaxLocked`] when the order is not editable
/// (cancelled, completed, paid, partly fulfilled, or synced from a store);
/// the VAT refusals as for [`create`].
pub async fn recalculate(
    conn: &mut PgConnection,
    tax: &Taxation<'_>,
    id: &str,
) -> Result<(), Error> {
    let stored = orders::load(conn, id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    if !stored.editable() {
        return Err(Error::TaxLocked);
    }
    ensure_no_open_payment(conn, id).await?;
    let order = &stored.order;
    let now = crate::now();
    let currency = stored.text("currency").unwrap_or("EUR").to_owned();
    let resolved: Vec<Line> = stored.items.iter().map(lines::stored_line).collect();
    let (_, keep) = discount_source(&stored, &Field::Absent);
    let known = stored_buyer(order);
    let plan = plan::price(
        conn,
        tax,
        &plan::Input {
            currency: &currency,
            lines: &resolved,
            discount_code: None,
            keep_discount_id: keep.as_deref(),
            shipping: requested_shipping(order),
            person_id: stored.text("personId"),
            counterparty_id: stored.text("counterpartyId"),
            email: stored.text("customerEmail"),
            order_id: Some(id),
            lock: true,
        },
        &Buyer {
            prices_include_tax: known.prices_include_tax,
            shipping_country: known.shipping_country.as_deref(),
            billing_country: known.billing_country.as_deref(),
            vat_number: known.vat_number.as_deref(),
        },
    )
    .await?;
    if let Some(problem) = plan.discount_problem {
        return Err(Error::Discount(problem));
    }
    write_item_amounts(conn, &stored, &resolved, &plan, &now).await?;
    let mut values = Map::new();
    put(&mut values, &ORDERS, "updatedAt", json!(now));
    plan_values(
        &mut values,
        &plan,
        &resolved,
        order.get("metadata").unwrap_or(&Value::Null),
    );
    ORDERS.patch_raw(&mut *conn, id, values, true).await?;
    Ok(())
}

/// A Mollie payment still open fixes an amount: while one is, the order's
/// total cannot change (a payment of the old total would otherwise settle
/// the new one). Refused with [`Error::PaymentInProgress`].
async fn ensure_no_open_payment(conn: &mut PgConnection, id: &str) -> Result<(), Error> {
    let open: Option<String> = commerce_payments::Entity::find()
        .select_only()
        .column(commerce_payments::Column::Id)
        .filter(commerce_payments::Column::OrderId.eq(id))
        .filter(commerce_payments::Column::Status.is_in(["open", "pending", "authorized"]))
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    if open.is_some() {
        return Err(Error::PaymentInProgress);
    }
    Ok(())
}

// ── cancel, pay ─────────────────────────────────────────────────────────────

/// Cancel an order and give back its discount redemption.
///
/// # Errors
/// [`Error::NotFound`]; [`Error::NotCancellable`] once it is cancelled,
/// completed or has fulfilled items.
pub async fn cancel(conn: &mut PgConnection, id: &str, reason: Option<&str>) -> Result<(), Error> {
    let stored = orders::load(conn, id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    if !stored.cancellable() {
        return Err(Error::NotCancellable);
    }
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "status", json!("cancelled"));
    put(&mut values, t, "cancelledAt", json!(now));
    put(&mut values, t, "cancelReason", json!(reason));
    put(&mut values, t, "updatedAt", json!(now));
    ORDERS.patch_raw(&mut *conn, id, values, true).await?;
    release(conn, id).await?;
    Ok(())
}

/// How an order was paid.
#[derive(Debug, Clone, Default)]
pub struct Payment {
    /// ISO timestamp; now when left out.
    pub paid_at: Option<String>,
    pub method: Option<String>,
    pub reference: Option<String>,
}

/// Record the payment of an order; a pending order becomes confirmed.
///
/// # Errors
/// [`Error::NotFound`]; [`Error::AlreadyPaid`]; [`Error::NotEditable`] for a
/// cancelled order.
pub async fn mark_paid(conn: &mut PgConnection, id: &str, payment: &Payment) -> Result<(), Error> {
    let stored = orders::load(conn, id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    if stored.text("approvalStatus") == Some("pending") {
        return Err(Error::ApprovalPending);
    }
    if status::is_paid(stored.text("paymentStatus").unwrap_or("pending")) {
        return Err(Error::AlreadyPaid);
    }
    if stored.text("status") == Some("cancelled") {
        return Err(Error::NotEditable(
            "A cancelled order cannot be paid".to_owned(),
        ));
    }
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "paymentStatus", json!("paid"));
    put(
        &mut values,
        t,
        "paidAt",
        json!(payment.paid_at.clone().unwrap_or_else(|| now.clone())),
    );
    put(&mut values, t, "paymentMethod", json!(payment.method));
    put(&mut values, t, "paymentReference", json!(payment.reference));
    if stored.text("status") == Some("pending") {
        put(&mut values, t, "status", json!("confirmed"));
    }
    put(&mut values, t, "updatedAt", json!(now));
    ORDERS.patch_raw(&mut *conn, id, values, true).await?;
    Ok(())
}

/// A pending order that is no longer waiting on anything but its fulfilment
/// becomes confirmed (an approved order on invoice).
///
/// # Errors
/// [`Error::NotFound`].
pub async fn confirm(conn: &mut PgConnection, id: &str) -> Result<(), Error> {
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "status", json!("confirmed"));
    put(&mut values, t, "updatedAt", json!(now));
    let stored = orders::load(conn, id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    if stored.text("status") == Some("pending") {
        ORDERS.patch_raw(&mut *conn, id, values, true).await?;
    }
    Ok(())
}

/// A storefront order placed on invoice (a B2B channel): the payment is
/// owed, not pending. It is confirmed too, unless it waits for an approval
/// (`confirmed` is refused to a pending approval; [`confirm`] follows it).
///
/// # Errors
/// [`Error::NotFound`].
pub async fn place_on_invoice(
    conn: &mut PgConnection,
    id: &str,
    confirmed: bool,
) -> Result<(), Error> {
    let now = crate::now();
    let t = &ORDERS;
    let mut values = Map::new();
    put(&mut values, t, "paymentStatus", json!("on_invoice"));
    put(&mut values, t, "paymentMethod", json!("invoice"));
    if confirmed {
        put(&mut values, t, "status", json!("confirmed"));
    }
    put(&mut values, t, "updatedAt", json!(now));
    ORDERS
        .patch_raw(&mut *conn, id, values, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", id))?;
    Ok(())
}

// ── import ──────────────────────────────────────────────────────────────────

/// A line of a store's order.
#[derive(Debug, Clone)]
pub struct ImportLine {
    /// The store's own id for the line: a re-import updates the same item.
    pub external_line_id: Option<String>,
    /// The product the store's product maps to, when it is known here.
    pub product_id: Option<String>,
    pub sku: Option<String>,
    pub name: String,
    pub quantity: f64,
    pub unit_price: String,
    pub total: String,
    pub image_url: Option<String>,
}

/// A store's order, mapped to this table's properties.
#[derive(Debug)]
pub struct Import<'a> {
    /// The order's id: the one the store's order maps to, or a new one.
    pub id: &'a str,
    /// The order exists (an update); otherwise it is inserted.
    pub existing: bool,
    /// The mapped order columns, by property. The store's order number,
    /// totals and statuses are kept as they are.
    pub header: Map<String, Value>,
    pub lines: &'a [ImportLine],
    /// The buyer the store's customer maps to.
    pub person_id: Option<&'a str>,
    pub owner_id: &'a str,
}

struct Stock {
    id: String,
    product_id: Option<String>,
    variant_id: Option<String>,
    sku: Option<String>,
    external_line_id: Option<String>,
    properties: Option<Value>,
}

impl Stock {
    /// The store line it was imported from: the column, else the property an
    /// older import kept.
    fn line_id(&self) -> Option<&str> {
        self.external_line_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .or_else(|| {
                self.properties
                    .as_ref()?
                    .get("externalLineId")?
                    .as_str()
                    .filter(|id| !id.is_empty())
            })
    }
}

/// By the store's line id, else (an item imported before line ids were kept)
/// by `(variant_id, product_id, sku)`, the first such item in creation
/// order. Each item is matched once.
fn match_item<'a>(
    line: &ImportLine,
    product_id: Option<&str>,
    existing: &'a [Stock],
    claimed: &[String],
) -> Option<&'a Stock> {
    let free = || existing.iter().filter(|item| !claimed.contains(&item.id));
    line.external_line_id
        .as_deref()
        .and_then(|id| free().find(|item| item.line_id() == Some(id)))
        .or_else(|| {
            free().find(|item| {
                item.line_id().is_none()
                    && item.variant_id.is_none()
                    && item.product_id.as_deref() == product_id
                    && item.sku == line.sku
            })
        })
}

fn number_json(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        json!(number as i64)
    } else if number.is_finite() {
        json!(number)
    } else {
        Value::Null
    }
}

/// Write a store's order: the header as mapped, then the items brought in
/// line with the store's lines without replacing them, so their ids stay put
/// (WeldStash pick lists point at them, and WeldStash owns
/// `fulfilled_quantity`, which this never writes). Matched items are updated
/// in place and stamped with the line id, new lines inserted, and a line the
/// store dropped is deleted only while nothing was fulfilled from it and no
/// pick list holds it. `item_count` and `total_quantity` then follow what is
/// stored, and the buyer's party becomes the counterparty once.
///
/// # Errors
/// A failed statement (a duplicate order number within the source included).
pub async fn import(conn: &mut PgConnection, import: &Import<'_>) -> Result<(), DbErr> {
    let now = crate::now();
    let mut header = import.header.clone();
    header.insert("updatedAt".to_owned(), json!(now));
    if import.existing {
        header.insert("deletedAt".to_owned(), Value::Null);
        let columns = ORDERS.values(&header);
        ORDERS
            .patch_raw(&mut *conn, import.id, columns, false)
            .await?;
    } else {
        header.insert("id".to_owned(), json!(import.id));
        let columns = ORDERS.values(&header);
        ORDERS
            .insert_raw(&mut *conn, columns)
            .await?;
    }
    import_items(conn, import, &now).await?;
    if let Some(person_id) = import.person_id {
        link_counterparty(conn, import.id, person_id, import.owner_id).await?;
    }
    Ok(())
}

#[allow(
    clippy::too_many_lines,
    reason = "the store's lines, then what it dropped, then the counts"
)]
async fn import_items(
    conn: &mut PgConnection,
    import: &Import<'_>,
    now: &str,
) -> Result<(), DbErr> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
    );
    let rows: Vec<Row> = order_items::Entity::find()
        .select_only()
        .column(order_items::Column::Id)
        .column(order_items::Column::ProductId)
        .column(order_items::Column::VariantId)
        .column(order_items::Column::Sku)
        .column(order_items::Column::ExternalLineId)
        .column(order_items::Column::Properties)
        .filter(order_items::Column::OrderId.eq(import.id))
        .order_by_asc(order_items::Column::CreatedAt)
        .order_by_asc(order_items::Column::Id)
        .into_tuple()
        .all(&db::on(conn))
        .await?;
    let existing: Vec<Stock> = rows
        .into_iter()
        .map(
            |(id, product_id, variant_id, sku, external_line_id, properties)| Stock {
                id,
                product_id,
                variant_id,
                sku,
                external_line_id,
                properties,
            },
        )
        .collect();

    let t = &ORDER_ITEMS;
    let mut claimed: Vec<String> = Vec::new();
    for line in import.lines {
        let mut values = Map::new();
        put(&mut values, t, "sku", json!(line.sku));
        put(&mut values, t, "name", json!(line.name));
        put(&mut values, t, "imageUrl", json!(line.image_url));
        put(&mut values, t, "quantity", number_json(line.quantity));
        put(&mut values, t, "unitPrice", json!(line.unit_price));
        put(&mut values, t, "total", json!(line.total));
        put(&mut values, t, "updatedAt", json!(now));
        if let Some(found) = match_item(line, line.product_id.as_deref(), &existing, &claimed) {
            claimed.push(found.id.clone());
            put(
                &mut values,
                t,
                "productId",
                json!(line.product_id.clone().or_else(|| found.product_id.clone())),
            );
            if let Some(line_id) = &line.external_line_id {
                put(&mut values, t, "externalLineId", json!(line_id));
                // The TypeScript import keeps the id in `properties` too:
                // merged in, so every other key stays.
                let mut properties = found
                    .properties
                    .as_ref()
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                properties.insert("externalLineId".to_owned(), json!(line_id));
                put(&mut values, t, "properties", Value::Object(properties));
            }
            ORDER_ITEMS
                .patch_raw(&mut *conn, &found.id, values, false)
                .await?;
            continue;
        }
        put(&mut values, t, "id", json!(generate_id("oitm")));
        put(&mut values, t, "orderId", json!(import.id));
        put(&mut values, t, "productId", json!(line.product_id));
        put(
            &mut values,
            t,
            "externalLineId",
            json!(line.external_line_id),
        );
        if let Some(line_id) = &line.external_line_id {
            put(
                &mut values,
                t,
                "properties",
                json!({ "externalLineId": line_id }),
            );
        }
        put(&mut values, t, "createdAt", json!(now));
        ORDER_ITEMS
            .insert_raw(&mut *conn, values)
            .await?;
    }

    let vanished: Vec<String> = existing
        .iter()
        .filter(|item| !claimed.contains(&item.id))
        .map(|item| item.id.clone())
        .collect();
    if !vanished.is_empty() {
        let removed = delete_free_items(conn, &vanished).await?;
        let kept = vanished.len() - removed.len();
        if kept > 0 {
            tracing::warn!(
                order_id = import.id,
                kept,
                "[commerce] kept items the store no longer lists (fulfilled or on a pick list)"
            );
        }
    }

    let counted: Option<(i64, Option<i64>)> = order_items::Entity::find()
        .select_only()
        .column_as(
            Expr::col((order_items::Entity, order_items::Column::Id)).count(),
            "item_count",
        )
        .column_as(
            Expr::col((order_items::Entity, order_items::Column::Quantity)).sum(),
            "total_quantity",
        )
        .filter(order_items::Column::OrderId.eq(import.id))
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    // `coalesce(sum(quantity), 0)`: an order with no items has none.
    let (item_count, total_quantity) = counted.map_or((0, 0), |(n, sum)| (n, sum.unwrap_or(0)));
    let differs = |key: &str, stored: i64| {
        #[allow(clippy::cast_precision_loss)]
        let stored = stored as f64;
        import.header.get(key).and_then(Value::as_f64) != Some(stored)
    };
    if differs("itemCount", item_count) || differs("totalQuantity", total_quantity) {
        let mut counts = Map::new();
        put(&mut counts, &ORDERS, "itemCount", json!(item_count));
        put(&mut counts, &ORDERS, "totalQuantity", json!(total_quantity));
        ORDERS
            .patch_raw(&mut *conn, import.id, counts, false)
            .await?;
    }
    Ok(())
}

/// An imported order whose buyer is known gets that person's party as its
/// counterparty, which WeldBooks invoices. Only while it has none: a
/// counterparty someone chose stays.
async fn link_counterparty(
    conn: &mut PgConnection,
    order_id: &str,
    person_id: &str,
    owner: &str,
) -> Result<(), DbErr> {
    let current: Option<Option<String>> = order_rows::Entity::find_by_id(order_id.to_owned())
        .select_only()
        .column(order_rows::Column::CounterpartyId)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    // No order, or one that already has a counterparty.
    if !matches!(current, Some(None)) {
        return Ok(());
    }
    let Some(party) = party_of(conn, false, person_id, owner).await? else {
        return Ok(());
    };
    order_rows::Entity::update_many()
        .col_expr(order_rows::Column::CounterpartyId, Expr::value(party))
        .filter(order_rows::Column::Id.eq(order_id))
        .filter(order_rows::Column::CounterpartyId.is_null())
        .exec(&db::on(conn))
        .await?;
    Ok(())
}
