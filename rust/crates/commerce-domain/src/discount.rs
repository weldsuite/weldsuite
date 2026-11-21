//! Discount codes: what a code is worth on an order, and why it is not.
//!
//! [`evaluate`] is pure: a [`Rule`], the order's lines and a [`Context`] give
//! the discount per line and the shipping it waives, or the first
//! [`Problem`] in the order the API reports them. [`load`] reads a code with
//! its counters (under a row lock when an order is about to redeem it).
//!
//! - `percentage`: the percentage of what the lines the code applies to cost,
//!   rounded to a cent, capped by `max_discount_amount`.
//! - `fixed_amount`: the amount, at most what those lines cost; only on an
//!   order in the code's currency.
//! - `free_shipping`: the shipping amount is waived (the order's
//!   `shipping_total` becomes zero), the lines are untouched.
//! - Minimums (`minimum_subtotal`, `minimum_quantity`) count the lines the
//!   code applies to. A discount that applies to `products` or `categories`
//!   with none of those lines is `NOT_ELIGIBLE`.
//! - A discount's share is spread over its lines in proportion to their
//!   price, to the cent ([`crate::money::allocate`]).
//! - Categories match a product's manual members; an automated category's
//!   rules are not evaluated here.

use serde_json::Value;
use sqlx::PgConnection;

use crate::money::{self, Cents};

/// Why a code does not apply. `as_str` is the API's `discountProblem`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    NotFound,
    NotActive,
    NotStarted,
    Expired,
    UsageLimit,
    CustomerLimit,
    MinimumSubtotal,
    MinimumQuantity,
    Currency,
    NotEligible,
}

impl Problem {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::NotActive => "NOT_ACTIVE",
            Self::NotStarted => "NOT_STARTED",
            Self::Expired => "EXPIRED",
            Self::UsageLimit => "USAGE_LIMIT",
            Self::CustomerLimit => "CUSTOMER_LIMIT",
            Self::MinimumSubtotal => "MINIMUM_SUBTOTAL",
            Self::MinimumQuantity => "MINIMUM_QUANTITY",
            Self::Currency => "CURRENCY",
            Self::NotEligible => "NOT_ELIGIBLE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Percentage,
    FixedAmount,
    FreeShipping,
}

impl Kind {
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "percentage" => Some(Self::Percentage),
            "fixed_amount" => Some(Self::FixedAmount),
            "free_shipping" => Some(Self::FreeShipping),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Products,
    Categories,
}

/// A discount as an order meets it.
#[derive(Debug, Clone)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the status and date flags the database derives"
)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub code: String,
    pub kind: Kind,
    /// Hundredths of a percent for `percentage`, cents for `fixed_amount`.
    pub value: Cents,
    pub currency: Option<String>,
    pub max_discount: Option<Cents>,
    pub scope: Scope,
    pub product_ids: Vec<String>,
    pub variant_ids: Vec<String>,
    /// The products in the discount's categories (manual members).
    pub category_product_ids: Vec<String>,
    pub minimum_subtotal: Option<Cents>,
    pub minimum_quantity: Option<i64>,
    pub usage_limit: Option<i64>,
    pub usage_limit_per_customer: Option<i64>,
    pub usage_count: i64,
    /// `status = 'active'`.
    pub active: bool,
    pub not_started: bool,
    pub expired: bool,
    /// The legacy customer list (`customer_eligibility = 'customers'`) holds
    /// the buyer, or there is none.
    pub customer_eligible: bool,
}

/// A line of the order the code is tried on.
#[derive(Debug, Clone)]
pub struct EvalLine {
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub quantity: i64,
    pub unit_price: Cents,
}

/// What else the evaluation depends on.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// The order's currency (ISO 4217).
    pub currency: &'a str,
    /// The shipping amount the staff member typed.
    pub shipping: Cents,
    /// How many times this buyer has redeemed the code (this order's own
    /// redemption excluded).
    pub customer_uses: i64,
}

/// What the code takes off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// The discount on each line, in the order of the lines.
    pub line_discounts: Vec<Cents>,
    /// The shipping the code waives.
    pub shipping_waived: Cents,
    /// Item discounts plus the shipping waived: what the redemption records.
    pub amount: Cents,
}

impl Rule {
    fn eligible(&self, line: &EvalLine) -> bool {
        let product = line.product_id.as_deref();
        let variant = line.variant_id.as_deref();
        match self.scope {
            Scope::All => true,
            Scope::Products => {
                product.is_some_and(|p| self.product_ids.iter().any(|id| id == p))
                    || variant.is_some_and(|v| self.variant_ids.iter().any(|id| id == v))
            }
            Scope::Categories => {
                product.is_some_and(|p| self.category_product_ids.iter().any(|id| id == p))
            }
        }
    }
}

/// The code on the order, or the first reason it does not apply.
///
/// # Errors
/// The [`Problem`], checked in this order: status, start, end, usage limit,
/// per-customer limit, currency, eligibility, minimum subtotal, minimum
/// quantity.
pub fn evaluate(
    rule: &Rule,
    lines: &[EvalLine],
    context: &Context<'_>,
) -> Result<Applied, Problem> {
    if !rule.active {
        return Err(Problem::NotActive);
    }
    if rule.not_started {
        return Err(Problem::NotStarted);
    }
    if rule.expired {
        return Err(Problem::Expired);
    }
    if rule
        .usage_limit
        .is_some_and(|limit| rule.usage_count >= limit)
    {
        return Err(Problem::UsageLimit);
    }
    if rule
        .usage_limit_per_customer
        .is_some_and(|limit| context.customer_uses >= limit)
    {
        return Err(Problem::CustomerLimit);
    }
    if rule.kind == Kind::FixedAmount
        && rule
            .currency
            .as_deref()
            .is_some_and(|c| !c.eq_ignore_ascii_case(context.currency))
    {
        return Err(Problem::Currency);
    }
    let eligible: Vec<bool> = lines.iter().map(|line| rule.eligible(line)).collect();
    if !rule.customer_eligible || (rule.scope != Scope::All && !eligible.iter().any(|e| *e)) {
        return Err(Problem::NotEligible);
    }
    let weights: Vec<Cents> = lines
        .iter()
        .zip(&eligible)
        .map(|(line, eligible)| {
            if *eligible {
                Cents::from(line.quantity) * line.unit_price
            } else {
                0
            }
        })
        .collect();
    let base: Cents = weights.iter().sum();
    let quantity: i64 = lines
        .iter()
        .zip(&eligible)
        .filter(|(_, eligible)| **eligible)
        .map(|(line, _)| line.quantity)
        .sum();
    if rule.minimum_subtotal.is_some_and(|minimum| base < minimum) {
        return Err(Problem::MinimumSubtotal);
    }
    if rule
        .minimum_quantity
        .is_some_and(|minimum| quantity < minimum)
    {
        return Err(Problem::MinimumQuantity);
    }
    let (items, shipping_waived) = match rule.kind {
        Kind::Percentage => {
            let mut amount = money::percent_of(base, rule.value);
            if let Some(cap) = rule.max_discount {
                amount = amount.min(cap);
            }
            (amount.min(base), 0)
        }
        Kind::FixedAmount => (rule.value.min(base), 0),
        Kind::FreeShipping => (0, context.shipping),
    };
    Ok(Applied {
        line_discounts: money::allocate(items, &weights),
        shipping_waived,
        amount: items + shipping_waived,
    })
}

/// `effectiveStatus`: the stored status with the dates and the usage folded
/// in. The list filter's SQL (`commerce` module) mirrors it.
#[must_use]
pub fn effective_status(
    status: &str,
    not_started: bool,
    expired: bool,
    used_up: bool,
) -> &'static str {
    match status {
        "archived" => "archived",
        "active" => {
            if expired {
                "expired"
            } else if used_up {
                "used_up"
            } else if not_started {
                "scheduled"
            } else {
                "active"
            }
        }
        _ => "draft",
    }
}

/// The columns [`load`] reads and the flags it derives, as one JSON object.
const RULE_SQL: &str = "select (to_jsonb(t) || jsonb_build_object(\
       'value', t.value::text, 'max_discount_amount', t.max_discount_amount::text, \
       'minimum_subtotal', t.minimum_subtotal::text, \
       'not_started', coalesce(t.starts_at > (now() at time zone 'utc'), false), \
       'expired', coalesce(t.ends_at <= (now() at time zone 'utc'), false), \
       'category_product_ids', coalesce((select jsonb_agg(cp.product_id) \
           from category_products cp \
           where t.applies_to = 'categories' \
             and cp.category_id in (select jsonb_array_elements_text(\
                 case when jsonb_typeof(t.category_ids) = 'array' \
                      then t.category_ids else '[]'::jsonb end))), '[]'::jsonb) \
     )) from discounts t \
     where t.deleted_at is null and lower(trim(t.code)) = lower(trim($1)) \
     order by (t.status <> 'archived') desc, t.updated_at desc, t.id desc limit 1";

/// A discount row and its [`Rule`].
#[derive(Debug, Clone)]
pub struct Loaded {
    pub rule: Rule,
    /// What the order says it was redeemed against: the buyer must hold the
    /// legacy eligibility list ids (`customer_ids`).
    pub customer_ids: Vec<String>,
    pub eligibility: String,
    /// The discount's `value` as stored (`"10.00"`).
    pub value_text: String,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn cents(value: Option<&Value>) -> Option<Cents> {
    value.and_then(Value::as_str).and_then(money::parse)
}

fn rule_of(row: &Value) -> Option<Loaded> {
    let text = |key: &str| row.get(key).and_then(Value::as_str);
    let flag = |key: &str| row.get(key).and_then(Value::as_bool).unwrap_or(false);
    let rule = Rule {
        id: text("id")?.to_owned(),
        name: text("name").unwrap_or_default().to_owned(),
        code: text("code").unwrap_or_default().to_owned(),
        kind: Kind::parse(text("type")?)?,
        value: cents(row.get("value")).unwrap_or(0),
        currency: text("currency").map(str::to_owned),
        max_discount: cents(row.get("max_discount_amount")),
        scope: match text("applies_to") {
            Some("products") => Scope::Products,
            Some("categories") => Scope::Categories,
            _ => Scope::All,
        },
        product_ids: strings(row.get("product_ids")),
        variant_ids: strings(row.get("variant_ids")),
        category_product_ids: strings(row.get("category_product_ids")),
        minimum_subtotal: cents(row.get("minimum_subtotal")),
        minimum_quantity: row.get("minimum_quantity").and_then(Value::as_i64),
        usage_limit: row.get("usage_limit").and_then(Value::as_i64),
        usage_limit_per_customer: row.get("usage_limit_per_customer").and_then(Value::as_i64),
        usage_count: row.get("usage_count").and_then(Value::as_i64).unwrap_or(0),
        active: text("status") == Some("active"),
        not_started: flag("not_started"),
        expired: flag("expired"),
        customer_eligible: true,
    };
    // `once_per_customer` is the legacy spelling of a per-customer limit of 1.
    let mut rule = rule;
    if flag("once_per_customer") {
        rule.usage_limit_per_customer = Some(rule.usage_limit_per_customer.map_or(1, |l| l.min(1)));
    }
    Some(Loaded {
        rule,
        customer_ids: strings(row.get("customer_ids")),
        eligibility: text("customer_eligibility").unwrap_or("all").to_owned(),
        value_text: text("value").unwrap_or("0").to_owned(),
    })
}

/// The discount with `code` (case-insensitive, trimmed), the non-archived one
/// first. With `lock`, its row is locked until the transaction ends, so two
/// orders cannot both take the last use.
///
/// # Errors
/// A failed statement.
pub async fn load(
    conn: &mut PgConnection,
    code: &str,
    lock: bool,
) -> Result<Option<Loaded>, sqlx::Error> {
    let sql = if lock {
        RULE_SQL.replace(" limit 1", " limit 1 for update of t")
    } else {
        RULE_SQL.to_owned()
    };
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(code)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().and_then(rule_of))
}

/// The discount `id`, deleted or not, with the same rule as [`load`]: for an
/// order that already holds it, so a later edit re-prices what was redeemed
/// instead of looking the code up again.
///
/// # Errors
/// A failed statement.
pub async fn load_by_id(
    conn: &mut PgConnection,
    id: &str,
    lock: bool,
) -> Result<Option<Loaded>, sqlx::Error> {
    let mut sql = RULE_SQL.replace(
        "t.deleted_at is null and lower(trim(t.code)) = lower(trim($1))",
        "t.id = $1",
    );
    if lock {
        sql = sql.replace(" limit 1", " limit 1 for update of t");
    }
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().and_then(rule_of))
}

/// How often this buyer redeemed the discount: by person, or by e-mail
/// address when the order carries one. `except_order` leaves that order's own
/// redemption out (an order being edited).
///
/// # Errors
/// A failed statement.
pub async fn customer_uses(
    conn: &mut PgConnection,
    discount_id: &str,
    person_id: Option<&str>,
    email: Option<&str>,
    except_order: Option<&str>,
) -> Result<i64, sqlx::Error> {
    if person_id.is_none() && email.is_none() {
        return Ok(0);
    }
    sqlx::query_scalar(
        "select count(*) from discount_redemptions r \
         where r.discount_id = $1 \
           and ($4::text is null or r.order_id <> $4) \
           and ((r.person_id is not null and r.person_id = $2) \
             or (r.customer_email is not null and lower(r.customer_email) = lower($3)))",
    )
    .bind(discount_id)
    .bind(person_id)
    .bind(email)
    .bind(except_order)
    .fetch_one(&mut *conn)
    .await
}

impl Loaded {
    /// Whether the legacy eligibility list lets this buyer in.
    #[must_use]
    pub fn admits(&self, buyer_ids: &[&str]) -> bool {
        self.eligibility != "customers"
            || self.customer_ids.is_empty()
            || buyer_ids
                .iter()
                .any(|id| self.customer_ids.iter().any(|c| c == id))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn rule(kind: Kind, value: Cents) -> Rule {
        Rule {
            id: "disc_1".into(),
            name: "Spring".into(),
            code: "SPRING".into(),
            kind,
            value,
            currency: Some("EUR".into()),
            max_discount: None,
            scope: Scope::All,
            product_ids: vec![],
            variant_ids: vec![],
            category_product_ids: vec![],
            minimum_subtotal: None,
            minimum_quantity: None,
            usage_limit: None,
            usage_limit_per_customer: None,
            usage_count: 0,
            active: true,
            not_started: false,
            expired: false,
            customer_eligible: true,
        }
    }

    fn line(product: &str, quantity: i64, unit_price: Cents) -> EvalLine {
        EvalLine {
            product_id: Some(product.into()),
            variant_id: None,
            quantity,
            unit_price,
        }
    }

    const CTX: Context<'static> = Context {
        currency: "EUR",
        shipping: 495,
        customer_uses: 0,
    };

    #[test]
    fn percentage_rounds_and_spreads() {
        let lines = [line("a", 1, 1001), line("b", 2, 999)];
        // 12.5% of 29.99 is 3.74875, 3.75.
        let applied = evaluate(&rule(Kind::Percentage, 1250), &lines, &CTX).unwrap();
        assert_eq!(applied.amount, 375);
        assert_eq!(applied.line_discounts.iter().sum::<Cents>(), 375);
        assert_eq!(applied.shipping_waived, 0);
        assert_eq!(applied.line_discounts.len(), 2);
    }

    #[test]
    fn percentage_is_capped() {
        let mut capped = rule(Kind::Percentage, 5000);
        capped.max_discount = Some(300);
        let applied = evaluate(&capped, &[line("a", 1, 2000)], &CTX).unwrap();
        assert_eq!(applied.amount, 300);
    }

    #[test]
    fn fixed_amount_never_exceeds_the_lines() {
        let applied =
            evaluate(&rule(Kind::FixedAmount, 5000), &[line("a", 1, 1250)], &CTX).unwrap();
        assert_eq!(applied.amount, 1250);
        assert_eq!(applied.line_discounts, vec![1250]);
    }

    #[test]
    fn fixed_amount_needs_the_currency() {
        let usd = Context {
            currency: "USD",
            ..CTX
        };
        assert_eq!(
            evaluate(&rule(Kind::FixedAmount, 500), &[line("a", 1, 1000)], &usd),
            Err(Problem::Currency)
        );
        // A percentage has no currency.
        assert!(evaluate(&rule(Kind::Percentage, 1000), &[line("a", 1, 1000)], &usd).is_ok());
    }

    #[test]
    fn free_shipping_waives_the_shipping_only() {
        let applied = evaluate(&rule(Kind::FreeShipping, 0), &[line("a", 1, 1000)], &CTX).unwrap();
        assert_eq!(applied.shipping_waived, 495);
        assert_eq!(applied.amount, 495);
        assert_eq!(applied.line_discounts, vec![0]);
    }

    #[test]
    fn problems_come_in_order() {
        let lines = [line("a", 1, 1000)];
        let mut r = rule(Kind::Percentage, 1000);
        r.active = false;
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::NotActive));
        r.active = true;
        r.not_started = true;
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::NotStarted));
        r.not_started = false;
        r.expired = true;
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::Expired));
        r.expired = false;
        r.usage_limit = Some(3);
        r.usage_count = 3;
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::UsageLimit));
        r.usage_count = 2;
        assert!(evaluate(&r, &lines, &CTX).is_ok());
        r.usage_limit_per_customer = Some(1);
        let used = Context {
            customer_uses: 1,
            ..CTX
        };
        assert_eq!(evaluate(&r, &lines, &used), Err(Problem::CustomerLimit));
        r.minimum_subtotal = Some(5000);
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::MinimumSubtotal));
        r.minimum_subtotal = None;
        r.minimum_quantity = Some(2);
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::MinimumQuantity));
        r.minimum_quantity = None;
        r.customer_eligible = false;
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::NotEligible));
    }

    #[test]
    fn scope_limits_the_lines_and_the_minimums() {
        let mut r = rule(Kind::Percentage, 1000);
        r.scope = Scope::Products;
        r.product_ids = vec!["a".into()];
        let lines = [line("a", 1, 1000), line("b", 1, 9000)];
        let applied = evaluate(&r, &lines, &CTX).unwrap();
        assert_eq!(applied.line_discounts, vec![100, 0]);
        // The minimum counts the discounted lines only.
        r.minimum_subtotal = Some(5000);
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::MinimumSubtotal));
        r.minimum_subtotal = None;
        r.product_ids = vec!["zzz".into()];
        assert_eq!(evaluate(&r, &lines, &CTX), Err(Problem::NotEligible));
        // A variant matches too.
        r.variant_ids = vec!["v1".into()];
        let by_variant = [EvalLine {
            product_id: Some("c".into()),
            variant_id: Some("v1".into()),
            quantity: 1,
            unit_price: 400,
        }];
        assert_eq!(evaluate(&r, &by_variant, &CTX).unwrap().amount, 40);
        // Categories go through their products.
        r.scope = Scope::Categories;
        r.category_product_ids = vec!["b".into()];
        assert_eq!(
            evaluate(&r, &lines, &CTX).unwrap().line_discounts,
            vec![0, 900]
        );
    }

    #[test]
    fn effective_status_folds_dates_and_usage() {
        assert_eq!(effective_status("draft", false, false, false), "draft");
        assert_eq!(effective_status("archived", false, true, false), "archived");
        assert_eq!(effective_status("active", false, false, false), "active");
        assert_eq!(effective_status("active", true, false, false), "scheduled");
        assert_eq!(effective_status("active", false, true, false), "expired");
        assert_eq!(effective_status("active", false, false, true), "used_up");
        assert_eq!(effective_status("active", true, true, true), "expired");
    }

    #[test]
    fn the_legacy_customer_list_admits_its_customers() {
        let loaded = Loaded {
            rule: rule(Kind::Percentage, 1000),
            customer_ids: vec!["pers_1".into()],
            eligibility: "customers".into(),
            value_text: "10.00".into(),
        };
        assert!(loaded.admits(&["pers_1"]));
        assert!(!loaded.admits(&["pers_2"]));
        assert!(!loaded.admits(&[]));
        let all = Loaded {
            eligibility: "all".into(),
            ..loaded
        };
        assert!(all.admits(&[]));
    }
}
