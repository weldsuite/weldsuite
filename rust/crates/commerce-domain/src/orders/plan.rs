//! What an order would be: its lines, the discount code's effect, the VAT
//! and the totals. Reads the discount (and its counters) and the seller's
//! VAT facts but writes nothing, so the quote route and the writes share it.
//!
//! [`plan`] is the amounts before VAT; [`price`] adds the VAT of
//! [`crate::vat`] and settles `tax_total` and `total`.

use sqlx::PgConnection;

use crate::discount::{self, Applied, Context, EvalLine, Kind, Problem};
use crate::error::Error;
use crate::money::{self, Cents};
use crate::orders::lines::Line;
use crate::totals::{self, Totals};
use crate::vat::{self, Buyer, Taxation, Vat};

/// The discount code on the order, when it applies.
#[derive(Debug, Clone)]
pub struct Redeemed {
    pub id: String,
    /// The code as the discount spells it.
    pub code: String,
    pub kind: &'static str,
    /// The discount's `value` as stored (`"10.00"`).
    pub value: String,
    /// Item discounts plus the shipping waived.
    pub amount: Cents,
    pub shipping_waived: Cents,
}

/// The inputs of a plan.
#[derive(Debug, Clone, Copy)]
pub struct Input<'a> {
    pub currency: &'a str,
    pub lines: &'a [Line],
    pub discount_code: Option<&'a str>,
    /// The discount the order already holds, kept as it is: re-priced by id,
    /// without the status, date and usage gates (the code may have expired
    /// or been archived since). Wins over `discount_code`.
    pub keep_discount_id: Option<&'a str>,
    /// The shipping the staff member typed.
    pub shipping: Cents,
    /// Who buys: the discount's per-customer limit and eligibility.
    pub person_id: Option<&'a str>,
    pub counterparty_id: Option<&'a str>,
    pub email: Option<&'a str>,
    /// The order being changed, whose own redemption does not count against
    /// the discount's limits.
    pub order_id: Option<&'a str>,
    /// Lock the discount row (an order is about to redeem it).
    pub lock: bool,
}

#[derive(Debug, Clone)]
pub struct Plan {
    /// The discount on each line, aligned with `Input::lines`.
    pub line_discounts: Vec<Cents>,
    /// Before [`price`], without VAT; after it, the order's amounts.
    pub totals: Totals,
    /// The order's VAT; set by [`price`].
    pub vat: Option<Vat>,
    /// The shipping as typed, before a free-shipping code.
    pub shipping_requested: Cents,
    pub discount: Option<Redeemed>,
    pub discount_problem: Option<Problem>,
}

impl Plan {
    /// A line's item `total`: what the buyer pays for it (with its VAT when
    /// the prices exclude it).
    #[must_use]
    pub fn line_total(&self, lines: &[Line], index: usize) -> Cents {
        match self.vat.as_ref().and_then(|vat| vat.lines.get(index)) {
            Some(line) => line.gross,
            None => totals_line(&lines[index], self.line_discounts[index]).total(),
        }
    }
}

fn totals_line(line: &Line, discount: Cents) -> totals::Line {
    totals::Line {
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount,
    }
}

/// Work out the order.
///
/// # Errors
/// A failed statement. A code that does not apply is not an error: it is in
/// [`Plan::discount_problem`], and the order is priced without it.
pub async fn plan(conn: &mut PgConnection, input: &Input<'_>) -> Result<Plan, sqlx::Error> {
    let mut applied: Option<Applied> = None;
    let mut redeemed: Option<Redeemed> = None;
    let mut problem = None;
    let code = input.discount_code.map(str::trim).filter(|c| !c.is_empty());
    let loaded = match (input.keep_discount_id, code) {
        (Some(id), _) => Some((discount::load_by_id(conn, id, input.lock).await?, true)),
        (None, Some(code)) => Some((discount::load(conn, code, input.lock).await?, false)),
        (None, None) => None,
    };
    if let Some((loaded, keep)) = loaded {
        match loaded {
            None => problem = Some(Problem::NotFound),
            Some(loaded) => {
                let mut rule = loaded.rule.clone();
                if keep {
                    // Already redeemed by this order: only what the lines and
                    // the buyer decide is checked again.
                    rule.active = true;
                    rule.not_started = false;
                    rule.expired = false;
                    rule.usage_limit = None;
                    rule.usage_limit_per_customer = None;
                }
                let buyer: Vec<&str> = [input.person_id, input.counterparty_id]
                    .into_iter()
                    .flatten()
                    .collect();
                rule.customer_eligible = loaded.admits(&buyer);
                // The order's own redemption is already in `usage_count`.
                let own: i64 = match input.order_id {
                    Some(order) => {
                        sqlx::query_scalar(
                            "select count(*) from discount_redemptions \
                             where discount_id = $1 and order_id = $2",
                        )
                        .bind(&rule.id)
                        .bind(order)
                        .fetch_one(&mut *conn)
                        .await?
                    }
                    None => 0,
                };
                rule.usage_count = (rule.usage_count - own).max(0);
                let customer_uses = discount::customer_uses(
                    conn,
                    &rule.id,
                    input.person_id,
                    input.email,
                    input.order_id,
                )
                .await?;
                let eval: Vec<EvalLine> = input
                    .lines
                    .iter()
                    .map(|line| EvalLine {
                        product_id: line.product_id.clone(),
                        variant_id: line.variant_id.clone(),
                        quantity: line.quantity,
                        unit_price: line.unit_price,
                    })
                    .collect();
                let context = Context {
                    currency: input.currency,
                    shipping: input.shipping,
                    customer_uses,
                };
                match discount::evaluate(&rule, &eval, &context) {
                    Ok(done) => {
                        redeemed = Some(Redeemed {
                            id: rule.id.clone(),
                            code: rule.code.clone(),
                            kind: kind_text(rule.kind),
                            value: loaded.value_text.clone(),
                            amount: done.amount,
                            shipping_waived: done.shipping_waived,
                        });
                        applied = Some(done);
                    }
                    Err(found) => problem = Some(found),
                }
            }
        }
    }
    let line_discounts = applied
        .as_ref()
        .map_or_else(|| vec![0; input.lines.len()], |a| a.line_discounts.clone());
    let shipping = input.shipping - applied.as_ref().map_or(0, |a| a.shipping_waived);
    let lines: Vec<totals::Line> = input
        .lines
        .iter()
        .zip(&line_discounts)
        .map(|(line, discount)| totals_line(line, *discount))
        .collect();
    Ok(Plan {
        line_discounts,
        totals: totals::totals(&lines, shipping),
        vat: None,
        shipping_requested: input.shipping,
        discount: redeemed,
        discount_problem: problem,
    })
}

/// [`plan`] with the order's VAT: the seller's engine decides the treatment
/// and the rate of every line, and `tax_total` and `total` follow.
///
/// # Errors
/// A failed statement, and the VAT refusals of [`vat::compute`]: no seller,
/// a seller outside the EU, a bad destination country, the engine failing.
pub async fn price(
    conn: &mut PgConnection,
    tax: &Taxation<'_>,
    input: &Input<'_>,
    buyer: &Buyer<'_>,
) -> Result<Plan, Error> {
    let mut plan = plan(conn, input).await?;
    let vat = vat::compute(
        conn,
        tax,
        buyer,
        &vat::Basis {
            lines: input.lines,
            discounts: &plan.line_discounts,
            shipping: plan.totals.shipping_total,
            pre_tax_total: plan.totals.total,
        },
    )
    .await?;
    plan.totals.tax_total = vat.tax_total;
    plan.totals.total = vat.total;
    plan.vat = Some(vat);
    Ok(plan)
}

fn kind_text(kind: Kind) -> &'static str {
    match kind {
        Kind::Percentage => "percentage",
        Kind::FixedAmount => "fixed_amount",
        Kind::FreeShipping => "free_shipping",
    }
}

/// The amount as the API writes it.
#[must_use]
pub fn amount(cents: Cents) -> String {
    money::format(cents)
}

/// A request to price an order without placing it.
#[derive(Clone, Copy)]
pub struct QuoteInput<'a> {
    pub tax: Taxation<'a>,
    pub buyer: Buyer<'a>,
    pub currency: &'a str,
    pub lines: &'a [crate::orders::lines::LineInput],
    pub discount_code: Option<&'a str>,
    pub shipping: Cents,
    pub company_id: Option<&'a str>,
    pub person_id: Option<&'a str>,
    pub email: Option<&'a str>,
}

/// An order priced, nothing written.
#[derive(Debug, Clone)]
pub struct Quote {
    pub lines: Vec<Line>,
    pub plan: Plan,
}

/// Price an order: the lines from the catalogue, the code's effect and the
/// VAT and totals. A line the catalogue cannot price carries its `problem`; a
/// code that does not apply is in `plan.discount_problem`.
///
/// # Errors
/// A failed statement, and the VAT refusals of [`price`].
pub async fn quote(conn: &mut PgConnection, input: &QuoteInput<'_>) -> Result<Quote, Error> {
    let lines = crate::orders::lines::resolve(conn, input.currency, input.lines, &[]).await?;
    // The buyer's party, when there is one already (a quote creates nothing).
    let mut counterparty: Option<String> = None;
    if let Some(company) = input.company_id {
        counterparty = sqlx::query_scalar(
            "select id from parties where company_id = $1 and deleted_at is null limit 1",
        )
        .bind(company)
        .fetch_optional(&mut *conn)
        .await?;
    }
    if counterparty.is_none()
        && let Some(person) = input.person_id
    {
        counterparty = sqlx::query_scalar(
            "select id from parties where person_id = $1 and deleted_at is null limit 1",
        )
        .bind(person)
        .fetch_optional(&mut *conn)
        .await?;
    }
    let plan = price(
        conn,
        &input.tax,
        &Input {
            currency: input.currency,
            lines: &lines,
            discount_code: input.discount_code,
            keep_discount_id: None,
            shipping: input.shipping,
            person_id: input.person_id,
            counterparty_id: counterparty.as_deref(),
            email: input.email,
            order_id: None,
            lock: false,
        },
        &input.buyer,
    )
    .await?;
    Ok(Quote { lines, plan })
}
