//! The replenishment engine: one item (a product or variant in one
//! warehouse) in, its plan out.
//!
//! Pure on purpose: no database, no clock, no I/O. `today` is an input, so
//! the nightly run, the demand chart and the tests get the same answer for
//! the same numbers. The planning run loads the inputs (the demand series,
//! stock, open purchase-order lines, supplier terms, the rule and the
//! settings) and stores the [`EngineOutput`] in `stash_item_plans`.
//!
//! [`plan_item`] follows the ten steps of the plan
//! (`weldsuite-documentation/plans/weldstash-replenishment.md`, "Engine"). Each step's function
//! quotes its formula, so the UI's explanation can quote the numbers.
//!
//! Where the plan leaves room, the engine:
//!
//! - starts the history at the item's first activity, the earlier of
//!   `first_activity` and the first day with demand: days before it are not
//!   zero demand and are left out of every statistic;
//! - counts a negative daily quantity (a return in an import) as zero;
//! - gives `sparse` items (fewer than 8 selling days) no seasonality;
//! - reports the deseasonalised level as `avg_daily_demand`, so the forecast
//!   for a day is `avg_daily_demand · seasonality[month]`;
//! - rounds an order up to whole packs after applying the minimum order
//!   quantity, `⌈max(raw, moq) / multiple⌉ · multiple` (the plan's
//!   `max(moq, ⌈raw / multiple⌉ · multiple)` is the same number whenever the
//!   MOQ is a whole number of packs);
//! - suggests nothing when `order_up_to − inventory_position ≤ 0`, even at
//!   the reorder point (otherwise an item with no demand and no stock would
//!   be sent its MOQ);
//! - keeps the forecast (cover, stockout date, chart) under a `min_max`
//!   rule, whose confidence is the forecast's, or `low` when the item is too
//!   new to have one;
//! - takes the available stock for the outlook as `on_hand − allocated`,
//!   in the stockout date as in `days_of_cover`, and looks for a stockout up
//!   to 365 days ahead (or `L + R` when that is longer);
//! - prices the suggestion (`suggested_qty · unit_cost`) whenever there is a
//!   plan and a unit cost, which is 0 when there is nothing to order;
//! - bounds silly inputs: lead time and review period to 0–3650 days, the
//!   service level to 0.5–0.999 (not a number: 0.95), a daily quantity to
//!   0–[`MAX_QUANTITY`], at most 3660 days of history; and keeps every
//!   output finite and inside the `stash_item_plans` columns (quantities
//!   within ±[`MAX_QUANTITY`], days of cover up to 99 999, demand up to
//!   9 999 999 999);
//! - treats float noise within 1e-9 of a whole number as that number in
//!   every ceiling and in the stockout comparison: 14 days of 5 a day can
//!   add up to 70.000 000 000 000 01, which must give a reorder point of 70,
//!   not 71.

use time::{Date, Duration};

/// Days in [`EngineOutput::daily_forecast`]: 13 weeks.
pub const FORECAST_DAYS: usize = 91;

/// The largest quantity the engine returns. `stash_item_plans`' integer
/// columns are `int4`.
pub const MAX_QUANTITY: i64 = 2_147_483_647;

/// [`MAX_QUANTITY`] as a float.
const MAX_QUANTITY_F64: f64 = 2_147_483_647.0;

/// Fewer days than this since the first activity: too new to forecast.
const MIN_HISTORY_DAYS: i64 = 28;

/// Fewer selling days than this in the history: the `sparse` method.
const MIN_NONZERO_DAYS: i64 = 8;

/// History needed for monthly seasonality.
const SEASONAL_SPAN_DAYS: usize = 365;

/// History from which a `seasonal` or `level` forecast is `ok`.
const OK_CONFIDENCE_DAYS: i64 = 90;

/// Half-life of the level's exponential weights.
const HALF_LIFE_DAYS: f64 = 30.0;

/// Bounds of a monthly index before it is renormalised.
const SEASON_INDEX_MIN: f64 = 0.25;
const SEASON_INDEX_MAX: f64 = 4.0;

/// How far ahead the stockout date is looked for (at least).
const STOCKOUT_HORIZON_DAYS: usize = 365;

/// History beyond this many days back is ignored.
const MAX_HISTORY_DAYS: i64 = 3660;

/// Bound of the lead time and the review period.
const MAX_POLICY_DAYS: i64 = 3650;

/// Service levels: the plan's default and the settings' range.
const DEFAULT_SERVICE_LEVEL: f64 = 0.95;
const MIN_SERVICE_LEVEL: f64 = 0.5;
const MAX_SERVICE_LEVEL: f64 = 0.999;

/// Output bounds that keep the `numeric` columns from overflowing:
/// `numeric(14,4)` (demand), `numeric(10,1)` (days of cover),
/// `numeric(18,2)` (value).
const MAX_DEMAND: f64 = 9_999_999_999.0;
const MAX_DAYS_OF_COVER: f64 = 99_999.0;
const MAX_VALUE: f64 = 1e15;

/// Relative distance from a whole number that counts as float noise.
const FLOAT_NOISE: f64 = 1e-9;

/// How an item is reordered: `stash_reorder_rules.method`, `Auto` when the
/// item has no rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleMethod {
    /// Forecast, safety stock, reorder point and order-up-to level.
    Auto,
    /// Order up to `max` when the inventory position is at or below `min`.
    MinMax { min: i64, max: i64 },
    /// Never suggest anything.
    Off,
}

/// The terms of the supplier the item is bought from (the product
/// supplier).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SupplierTerms {
    /// The minimum order quantity in units, if any.
    pub min_order_qty: Option<i64>,
    /// Pack or case size: an order is a whole number of these (below 1
    /// counts as 1).
    pub order_multiple: i64,
    /// Price per unit in the supplier's currency, if known.
    pub unit_cost: Option<f64>,
}

/// The item's stock in the warehouse, in units.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Position {
    /// On hand in the warehouse's buckets, quarantined stock excluded.
    pub on_hand: i64,
    /// Reserved for pick lists.
    pub allocated: i64,
    /// Still to arrive on open purchase-order lines.
    pub incoming: i64,
    /// Ordered by customers, not fulfilled and not on a pick list yet.
    pub open_demand: i64,
}

/// An open purchase-order line's remaining quantity and when it arrives
/// (the PO's expected date, or today + lead time when it has none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedReceipt {
    pub date: Date,
    pub quantity: i64,
}

/// Everything [`plan_item`] needs for one item in one warehouse.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineInput {
    pub today: Date,
    /// Daily quantities; `daily_demand[0]` is `history_start`, the last entry is yesterday.
    pub history_start: Date,
    pub daily_demand: Vec<i64>,
    /// First day the item could have sold (first demand or product creation), for the history check.
    pub first_activity: Option<Date>,
    /// `L`, in days.
    pub lead_time_days: i64,
    /// `R`, in days.
    pub review_period_days: i64,
    /// `p`, the chance of not running out during a lead time (0.95 = 95%).
    pub service_level: f64,
    pub rule: RuleMethod,
    pub supplier: Option<SupplierTerms>,
    pub position: Position,
    pub receipts: Vec<ExpectedReceipt>,
}

/// How the plan was made: `stash_item_plans.method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMethod {
    /// Level with monthly seasonality (a year of history or more).
    Seasonal,
    /// Level without seasonality.
    Level,
    /// Fewer than 8 selling days: Poisson variability.
    Sparse,
    /// The item's min/max rule.
    MinMax,
    /// No plan: too new, or the rule is off.
    None,
}

impl PlanMethod {
    /// The value stored in `stash_item_plans.method`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Seasonal => "seasonal",
            Self::Level => "level",
            Self::Sparse => "sparse",
            Self::MinMax => "min_max",
            Self::None => "none",
        }
    }
}

/// How far the forecast can be trusted: `stash_item_plans.confidence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    None,
    Low,
    Ok,
}

impl Confidence {
    /// The value stored in `stash_item_plans.confidence`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Ok => "ok",
        }
    }
}

/// One item's plan: the computed columns of `stash_item_plans`.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineOutput {
    pub method: PlanMethod,
    pub confidence: Confidence,
    /// Days of history used (from the first activity, at most the series).
    pub history_days: i64,
    /// Days in that history with demand.
    pub nonzero_days: i64,
    /// The deseasonalised level, units a day.
    pub avg_daily_demand: Option<f64>,
    /// `σ`, units a day.
    pub demand_std_dev: Option<f64>,
    /// Monthly indices, January first, mean 1 (`seasonal` only).
    pub seasonality: Option<[f64; 12]>,
    pub forecast_30d: Option<f64>,
    pub forecast_90d: Option<f64>,
    pub safety_stock: Option<i64>,
    pub reorder_point: Option<i64>,
    pub order_up_to: Option<i64>,
    pub inventory_position: i64,
    pub days_of_cover: Option<f64>,
    pub stockout_date: Option<Date>,
    /// Units to order now; 0 is nothing.
    pub suggested_qty: i64,
    /// `suggested_qty · unit_cost`, in the supplier's currency.
    pub suggested_value: Option<f64>,
    /// Forecast per day for the next 91 days (index 0 = today), empty without a forecast.
    pub daily_forecast: Vec<f64>,
}

/// Plans one item in one warehouse: the plan's steps 1 to 10.
pub fn plan_item(input: &EngineInput) -> EngineOutput {
    let history = History::read(input);
    let history_days = len_i64(history.days.len());
    let inventory_position = inventory_position(&input.position);
    let mut out = EngineOutput {
        method: PlanMethod::None,
        confidence: Confidence::None,
        history_days,
        nonzero_days: history.nonzero_days,
        avg_daily_demand: None,
        demand_std_dev: None,
        seasonality: None,
        forecast_30d: None,
        forecast_90d: None,
        safety_stock: None,
        reorder_point: None,
        order_up_to: None,
        inventory_position,
        days_of_cover: None,
        stockout_date: None,
        suggested_qty: 0,
        suggested_value: None,
        daily_forecast: Vec::new(),
    };
    if input.rule == RuleMethod::Off {
        return out;
    }
    let lead = policy_days(input.lead_time_days);
    let review = policy_days(input.review_period_days);

    // Step 1: too new (fewer than 28 days since the first activity) means
    // no forecast. Steps 2 to 5 fit and project it.
    let fitted = history.is_old_enough().then(|| {
        let forecast = Forecast::fit(&history);
        let horizon = STOCKOUT_HORIZON_DAYS.max(lead + review).max(FORECAST_DAYS);
        let outlook = Outlook::project(&forecast, input.today, horizon);
        (forecast, outlook)
    });
    if let Some((forecast, outlook)) = &fitted {
        describe_forecast(&mut out, forecast, outlook, input);
    }

    // Step 6: the policy, from the forecast or the min/max rule.
    let policy = match (input.rule, &fitted) {
        (RuleMethod::MinMax { min, max }, _) => {
            out.method = PlanMethod::MinMax;
            if fitted.is_none() {
                out.confidence = Confidence::Low;
            }
            min_max_policy(min, max)
        }
        (RuleMethod::Auto, Some((forecast, outlook))) => {
            auto_policy(forecast, outlook, lead, review, input.service_level)
        }
        _ => return out,
    };
    out.safety_stock = policy.safety_stock;
    out.reorder_point = Some(policy.reorder_point);
    out.order_up_to = Some(policy.order_up_to);

    // Step 8: the suggestion.
    out.suggested_qty = suggest(inventory_position, &policy, input.supplier.as_ref());
    out.suggested_value = suggested_value(out.suggested_qty, input.supplier.as_ref());
    out
}

/// Rounds a wanted quantity to what can be ordered:
/// `⌈max(raw, min_order_qty) / order_multiple⌉ · order_multiple`, so the
/// order is at least the MOQ and a whole number of packs. An
/// `order_multiple` below 1 counts as 1; the result is at most
/// [`MAX_QUANTITY`].
pub fn round_order_qty(raw: i64, min_order_qty: i64, order_multiple: i64) -> i64 {
    let multiple = order_multiple.clamp(1, MAX_QUANTITY);
    let wanted = raw.max(min_order_qty).clamp(0, MAX_QUANTITY);
    let packs = wanted / multiple + i64::from(wanted % multiple != 0);
    let quantity = packs.saturating_mul(multiple);
    if quantity > MAX_QUANTITY {
        MAX_QUANTITY / multiple * multiple
    } else {
        quantity
    }
}

/// One day of the usable history.
#[derive(Debug, Clone, Copy)]
struct Day {
    quantity: f64,
    /// Calendar month, 0 = January.
    month: usize,
}

/// The demand series cut to the item's life.
struct History {
    /// From the first activity (or the series' start, when that is later)
    /// to yesterday, oldest first.
    days: Vec<Day>,
    nonzero_days: i64,
    /// Days since the first activity; `None` without any (no demand and no
    /// `first_activity`).
    age_days: Option<i64>,
}

impl History {
    /// The first activity is the earlier of `first_activity` and the first
    /// day with demand. Days are offsets from today (yesterday is -1); the
    /// series covers `[history_start, today)`, and a day past its end has
    /// no demand.
    fn read(input: &EngineInput) -> Self {
        let today = input.today;
        let start = days_between(input.history_start, today);
        let dated = usize::try_from(start.saturating_neg())
            .unwrap_or(0)
            .min(input.daily_demand.len());
        let first_demand = input.daily_demand[..dated]
            .iter()
            .position(|&quantity| quantity > 0)
            .map(|index| start.saturating_add(len_i64(index)));
        let first_activity = input.first_activity.map(|date| days_between(date, today));
        let activity = match (first_activity, first_demand) {
            (Some(created), Some(sold)) => Some(created.min(sold)),
            (created, sold) => created.or(sold),
        };
        let Some(activity) = activity else {
            return Self {
                days: Vec::new(),
                nonzero_days: 0,
                age_days: None,
            };
        };
        let from = activity.max(start).max(-MAX_HISTORY_DAYS);
        let mut days = Vec::with_capacity(usize::try_from(-from).unwrap_or(0));
        if let Some(mut date) = offset_date(today, from) {
            for offset in from..0 {
                let quantity = usize::try_from(offset - start)
                    .ok()
                    .and_then(|index| input.daily_demand.get(index))
                    .map_or(0.0, |&quantity| demand_quantity(quantity));
                days.push(Day {
                    quantity,
                    month: month_index(date),
                });
                match date.next_day() {
                    Some(next) => date = next,
                    None => break,
                }
            }
        }
        let nonzero_days = len_i64(days.iter().filter(|day| day.quantity > 0.0).count());
        Self {
            days,
            nonzero_days,
            age_days: Some(activity.saturating_neg()),
        }
    }

    /// Step 1, history check: at least 28 days since the first activity.
    fn is_old_enough(&self) -> bool {
        self.age_days.is_some_and(|age| age >= MIN_HISTORY_DAYS)
    }
}

/// Steps 1 to 4: the method, seasonality, level and variability.
struct Forecast {
    /// `Seasonal`, `Level` or `Sparse`.
    method: PlanMethod,
    seasonality: Option<[f64; 12]>,
    level: f64,
    std_dev: f64,
}

impl Forecast {
    fn fit(history: &History) -> Self {
        // Step 1: fewer than 8 selling days is `sparse`.
        let sparse = history.nonzero_days < MIN_NONZERO_DAYS;
        // Step 2: seasonality from a year of history, else all `s_k = 1`.
        let seasonality = if sparse || history.days.len() < SEASONAL_SPAN_DAYS {
            None
        } else {
            seasonal_indices(&history.days)
        };
        // Steps 3 and 4.
        let (level, spread) = level_and_spread(&history.days, &seasonality.unwrap_or([1.0; 12]));
        let (method, std_dev) = if sparse {
            // Poisson: `σ_L = √D_L`, which is `√level` a day.
            (PlanMethod::Sparse, level.sqrt())
        } else if seasonality.is_some() {
            (PlanMethod::Seasonal, spread)
        } else {
            (PlanMethod::Level, spread)
        };
        Self {
            method,
            seasonality,
            level,
            std_dev,
        }
    }

    /// `s_month`, 0 = January.
    fn index(&self, month: usize) -> f64 {
        self.seasonality.map_or(1.0, |indices| indices[month])
    }
}

/// Step 2, seasonality (a year of history or more):
/// `raw_k = mean(month k) / mean(all)`, shrunk towards 1 by the years of
/// data `y = history_days / 365`: `s_k = 1 + (raw_k − 1) · y / (y + 1)`,
/// clamped to [0.25, 4], then divided by their mean so they average 1.
/// `None` when there is no demand at all.
fn seasonal_indices(days: &[Day]) -> Option<[f64; 12]> {
    if days.is_empty() {
        return None;
    }
    let mut sums = [0.0_f64; 12];
    let mut counts = [0_usize; 12];
    for day in days {
        sums[day.month] += day.quantity;
        counts[day.month] += 1;
    }
    let mean_all = sums.iter().sum::<f64>() / len_f64(days.len());
    if mean_all.is_nan() || mean_all <= 0.0 {
        return None;
    }
    let years = len_f64(days.len()) / 365.0;
    let shrink = years / (years + 1.0);
    let mut indices = [1.0_f64; 12];
    for ((index, sum), count) in indices.iter_mut().zip(sums).zip(counts) {
        if count > 0 {
            let raw = sum / len_f64(count) / mean_all;
            *index = (1.0 + (raw - 1.0) * shrink).clamp(SEASON_INDEX_MIN, SEASON_INDEX_MAX);
        }
    }
    let mean = indices.iter().sum::<f64>() / 12.0;
    for index in &mut indices {
        *index /= mean;
    }
    Some(indices)
}

/// Steps 3 and 4. Level: deseasonalise, `e_t = d_t / s_month(t)`, and take
/// the exponentially weighted mean with a 30-day half-life,
/// `w_t = 0.5^(age_t / 30)` (yesterday's age is 0):
/// `level = Σ w_t · e_t / Σ w_t`. Variability, the weighted standard
/// deviation around it: `σ = √(Σ w_t · (e_t − level)² / Σ w_t)`.
/// Both 0 without history.
fn level_and_spread(days: &[Day], indices: &[f64; 12]) -> (f64, f64) {
    let newest = days.len().saturating_sub(1);
    let points: Vec<(f64, f64)> = days
        .iter()
        .enumerate()
        .map(|(position, day)| {
            let age = len_f64(newest - position);
            (
                0.5_f64.powf(age / HALF_LIFE_DAYS),
                day.quantity / indices[day.month],
            )
        })
        .collect();
    let weights: f64 = points.iter().map(|&(weight, _)| weight).sum();
    if weights.is_nan() || weights <= 0.0 {
        return (0.0, 0.0);
    }
    let level = points
        .iter()
        .map(|&(weight, demand)| weight * demand)
        .sum::<f64>()
        / weights;
    let variance = points
        .iter()
        .map(|&(weight, demand)| weight * (demand - level).powi(2))
        .sum::<f64>()
        / weights;
    (level, variance.max(0.0).sqrt())
}

/// Step 5, the forecast from today on: `f(t) = level · s_month(t)`.
struct Outlook {
    /// Calendar month of each day, index 0 = today.
    months: Vec<usize>,
    /// `f(t)`, index 0 = today.
    daily: Vec<f64>,
}

impl Outlook {
    fn project(forecast: &Forecast, today: Date, days: usize) -> Self {
        let mut months = Vec::with_capacity(days);
        let mut date = Some(today);
        while let Some(day) = date {
            if months.len() >= days {
                break;
            }
            months.push(month_index(day));
            date = day.next_day();
        }
        let daily = months
            .iter()
            .map(|&month| forecast.level * forecast.index(month))
            .collect();
        Self { months, daily }
    }

    /// `Σ f` over `days` days from day `from` (0 = today).
    fn total(&self, from: usize, days: usize) -> f64 {
        self.daily.iter().skip(from).take(days).sum()
    }
}

/// The forecast's columns (steps 5, 9 and 10), whatever the rule.
fn describe_forecast(
    out: &mut EngineOutput,
    forecast: &Forecast,
    outlook: &Outlook,
    input: &EngineInput,
) {
    let forecast_30d = outlook.total(0, 30);
    out.method = forecast.method;
    out.confidence = confidence(forecast.method, out.history_days);
    out.avg_daily_demand = Some(demand_value(forecast.level));
    out.demand_std_dev = Some(demand_value(forecast.std_dev));
    out.seasonality = forecast.seasonality;
    out.forecast_30d = Some(demand_value(forecast_30d));
    out.forecast_90d = Some(demand_value(outlook.total(0, 90)));
    out.daily_forecast = outlook.daily.iter().take(FORECAST_DAYS).copied().collect();
    let available = available_stock(&input.position);
    out.days_of_cover = days_of_cover(available, forecast_30d);
    out.stockout_date = stockout_date(input.today, &outlook.daily, available, &input.receipts);
}

/// The reorder policy (step 6).
struct Policy {
    safety_stock: Option<i64>,
    reorder_point: i64,
    order_up_to: i64,
}

/// Step 6. `z = Φ⁻¹(p)`; with `D_L = Σ f` over the next `L` days, `D_R = Σ f`
/// over the `R` days after that and `s̄_L` the mean seasonal index over the
/// next `L` days:
/// `safety_stock = ⌈z · σ · s̄_L · √L⌉`,
/// `reorder_point = ⌈D_L + safety_stock⌉`,
/// `order_up_to = reorder_point + ⌈D_R⌉`.
/// For `sparse`, `σ = √level` and `s̄_L = 1`, which makes the safety stock
/// the Poisson `⌈z · √D_L⌉`. With `L = 0` there is no safety stock and no
/// lead-time demand.
fn auto_policy(
    forecast: &Forecast,
    outlook: &Outlook,
    lead: usize,
    review: usize,
    service_level: f64,
) -> Policy {
    let z = z_score(service_level);
    let lead_demand = outlook.total(0, lead);
    let review_demand = outlook.total(lead, review);
    let (index_sum, index_days) = outlook
        .months
        .iter()
        .take(lead)
        .fold((0.0, 0_usize), |(sum, days), &month| {
            (sum + forecast.index(month), days + 1)
        });
    let lead_index = if index_days == 0 {
        1.0
    } else {
        index_sum / len_f64(index_days)
    };
    let safety_stock = ceil_qty(z * forecast.std_dev * lead_index * len_f64(lead).sqrt());
    let reorder_point = ceil_qty(lead_demand)
        .saturating_add(safety_stock)
        .min(MAX_QUANTITY);
    let order_up_to = reorder_point
        .saturating_add(ceil_qty(review_demand))
        .min(MAX_QUANTITY);
    Policy {
        safety_stock: Some(safety_stock),
        reorder_point,
        order_up_to,
    }
}

/// Step 6 under a `min_max` rule: `reorder_point = min`,
/// `order_up_to = max` (at least `min`), no safety stock.
fn min_max_policy(min: i64, max: i64) -> Policy {
    let reorder_point = min.clamp(0, MAX_QUANTITY);
    Policy {
        safety_stock: None,
        reorder_point,
        order_up_to: max.clamp(reorder_point, MAX_QUANTITY),
    }
}

/// `z = Φ⁻¹(p)` for the service level `p`, clamped to the settings' range
/// 0.5–0.999 (not a number: the default 0.95).
fn z_score(service_level: f64) -> f64 {
    let p = if service_level.is_nan() {
        DEFAULT_SERVICE_LEVEL
    } else {
        service_level.clamp(MIN_SERVICE_LEVEL, MAX_SERVICE_LEVEL)
    };
    inverse_normal_cdf(p).max(0.0)
}

/// `Φ⁻¹(p)`, the standard normal quantile, for `p` in (0, 1): Peter
/// Acklam's rational approximation (relative error below 1.2e-9), central
/// region for 0.02425 ≤ p ≤ 0.97575, tail formula outside it.
#[allow(clippy::unreadable_literal)] // the published coefficients, verbatim
fn inverse_normal_cdf(p: f64) -> f64 {
    const A: [f64; 6] = [
        -3.969683028665376e1,
        2.209460984245205e2,
        -2.759285104469687e2,
        1.38357751867269e2,
        -3.066479806614716e1,
        2.506628277459239e0,
    ];
    const B: [f64; 5] = [
        -5.447609879822406e1,
        1.615858368580409e2,
        -1.556989798598866e2,
        6.680131188771972e1,
        -1.328068155288572e1,
    ];
    const C: [f64; 6] = [
        -7.784894002430293e-3,
        -3.223964580411365e-1,
        -2.400758277161838e0,
        -2.549732539343734e0,
        4.374664141464968e0,
        2.938163982698783e0,
    ];
    const D: [f64; 4] = [
        7.784695709041462e-3,
        3.224671290700398e-1,
        2.445134137142996e0,
        3.754408661907416e0,
    ];
    const P_LOW: f64 = 0.02425;
    let horner = |coefficients: &[f64], x: f64| {
        coefficients
            .iter()
            .fold(0.0, |sum, &coefficient| sum * x + coefficient)
    };
    let tail = |p: f64| {
        let q = (-2.0 * p.ln()).sqrt();
        horner(&C, q) / (horner(&D, q) * q + 1.0)
    };
    if p < P_LOW {
        tail(p)
    } else if p > 1.0 - P_LOW {
        -tail(1.0 - p)
    } else {
        let q = p - 0.5;
        let r = q * q;
        horner(&A, r) * q / (horner(&B, r) * r + 1.0)
    }
}

/// Step 7. `inventory_position = (on_hand − allocated) + incoming − open_demand`.
fn inventory_position(position: &Position) -> i64 {
    position
        .on_hand
        .saturating_sub(position.allocated)
        .saturating_add(position.incoming)
        .saturating_sub(position.open_demand)
        .clamp(-MAX_QUANTITY, MAX_QUANTITY)
}

/// Stock free to sell now: `on_hand − allocated`.
fn available_stock(position: &Position) -> i64 {
    position
        .on_hand
        .saturating_sub(position.allocated)
        .clamp(-MAX_QUANTITY, MAX_QUANTITY)
}

/// Step 8. At or below the reorder point
/// (`inventory_position ≤ reorder_point`), order
/// `raw = order_up_to − inventory_position`, rounded by
/// [`round_order_qty`] to the MOQ and whole packs; nothing when `raw ≤ 0`
/// or above the reorder point.
fn suggest(position: i64, policy: &Policy, supplier: Option<&SupplierTerms>) -> i64 {
    if position > policy.reorder_point {
        return 0;
    }
    let raw = policy.order_up_to.saturating_sub(position);
    if raw <= 0 {
        return 0;
    }
    let (min_order_qty, order_multiple) = supplier.map_or((0, 1), |terms| {
        (terms.min_order_qty.unwrap_or(0), terms.order_multiple)
    });
    round_order_qty(raw, min_order_qty, order_multiple)
}

/// `suggested_qty · unit_cost`, when the unit cost is a number ≥ 0.
fn suggested_value(quantity: i64, supplier: Option<&SupplierTerms>) -> Option<f64> {
    supplier
        .and_then(|terms| terms.unit_cost)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .map(|cost| (as_f64(quantity) * cost).min(MAX_VALUE))
}

/// Step 9. `days_of_cover = (on_hand − allocated) / mean(f over 30 days)`,
/// 0 when nothing is available, `None` when nothing is forecast to sell.
fn days_of_cover(available: i64, forecast_30d: f64) -> Option<f64> {
    let daily = forecast_30d / 30.0;
    if daily.is_nan() || daily <= 0.0 {
        return None;
    }
    Some((as_f64(available.max(0)) / daily).min(MAX_DAYS_OF_COVER))
}

/// Step 9. `stockout_date`: the first day on which the cumulative forecast
/// from today exceeds the available stock (`on_hand − allocated`) plus the
/// receipts due by that day. A receipt dated in the past counts today.
/// `None` when that doesn't happen within the forecast horizon.
fn stockout_date(
    today: Date,
    daily: &[f64],
    available: i64,
    receipts: &[ExpectedReceipt],
) -> Option<Date> {
    let mut due: Vec<(usize, i64)> = receipts
        .iter()
        .filter(|receipt| receipt.quantity > 0)
        .map(|receipt| {
            let day = usize::try_from(days_between(receipt.date, today)).unwrap_or(0);
            (day, receipt.quantity)
        })
        .collect();
    due.sort_unstable_by_key(|&(day, _)| day);
    let mut due = due.into_iter().peekable();
    let mut stock = available;
    let mut demand = 0.0;
    for (day, &forecast) in daily.iter().enumerate() {
        while let Some((_, quantity)) = due.next_if(|&(arrives, _)| arrives <= day) {
            stock = stock.saturating_add(quantity);
        }
        demand += forecast;
        let stock = as_f64(stock);
        if demand > stock + FLOAT_NOISE * stock.abs().max(1.0) {
            return offset_date(today, len_i64(day));
        }
    }
    None
}

/// Step 10. `ok` for `seasonal` or `level` with 90 days of history or more;
/// `low` for `sparse` or less history; `none` without a plan.
fn confidence(method: PlanMethod, history_days: i64) -> Confidence {
    match method {
        PlanMethod::None => Confidence::None,
        PlanMethod::Seasonal | PlanMethod::Level if history_days >= OK_CONFIDENCE_DAYS => {
            Confidence::Ok
        }
        _ => Confidence::Low,
    }
}

/// The lead time or review period in days, within 0–3650.
fn policy_days(days: i64) -> usize {
    usize::try_from(days.clamp(0, MAX_POLICY_DAYS)).unwrap_or(0)
}

/// A day's demand: negative counts as 0, at most [`MAX_QUANTITY`].
fn demand_quantity(quantity: i64) -> f64 {
    as_f64(quantity.clamp(0, MAX_QUANTITY))
}

/// A demand figure as stored: finite, within 0–[`MAX_DEMAND`].
fn demand_value(value: f64) -> f64 {
    if value.is_nan() {
        0.0
    } else {
        value.clamp(0.0, MAX_DEMAND)
    }
}

/// `⌈x⌉` as a quantity in 0–[`MAX_QUANTITY`]. A value within float noise
/// of a whole number is that number.
fn ceil_qty(value: f64) -> i64 {
    if value.is_nan() || value <= 0.0 {
        return 0;
    }
    let nearest = value.round();
    let ceiling = if (value - nearest).abs() <= FLOAT_NOISE * value.max(1.0) {
        nearest
    } else {
        value.ceil()
    };
    whole_to_i64(ceiling.min(MAX_QUANTITY_F64))
}

/// A whole, non-negative float no larger than [`MAX_QUANTITY`] as an
/// integer.
#[allow(clippy::cast_possible_truncation)] // whole and in range: exact
fn whole_to_i64(value: f64) -> i64 {
    (value as i64).clamp(0, MAX_QUANTITY)
}

/// A quantity as a float.
#[allow(clippy::cast_precision_loss)] // exact below 2^53, far above any real stock
fn as_f64(quantity: i64) -> f64 {
    quantity as f64
}

/// A count as a float.
#[allow(clippy::cast_precision_loss)] // counts of days: exact
fn len_f64(count: usize) -> f64 {
    count as f64
}

/// A count as an integer.
fn len_i64(count: usize) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

/// `later − earlier` in days.
fn days_between(later: Date, earlier: Date) -> i64 {
    (later - earlier).whole_days()
}

/// `today + offset` days, `None` past the calendar's range. `offset` is
/// small (a policy horizon or a history window).
fn offset_date(today: Date, offset: i64) -> Option<Date> {
    today.checked_add(Duration::days(offset))
}

/// The month of `date`, 0 = January.
fn month_index(date: Date) -> usize {
    usize::from(u8::from(date.month())) - 1
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use time::Month;

    use super::*;

    fn date(text: &str) -> Date {
        let part = |from: usize, to: usize| -> i32 {
            text.get(from..to)
                .and_then(|digits| digits.parse().ok())
                .unwrap_or_else(|| panic!("{text} is not a YYYY-MM-DD date"))
        };
        let month = u8::try_from(part(5, 7))
            .ok()
            .and_then(|month| Month::try_from(month).ok())
            .unwrap_or_else(|| panic!("{text}: bad month"));
        let day = u8::try_from(part(8, 10)).unwrap_or_else(|_| panic!("{text}: bad day"));
        Date::from_calendar_date(part(0, 4), month, day)
            .unwrap_or_else(|_| panic!("{text} is not a date"))
    }

    fn iso(date: Date) -> String {
        format!(
            "{:04}-{:02}-{:02}",
            date.year(),
            u8::from(date.month()),
            date.day()
        )
    }

    fn int(value: &Value, key: &str) -> i64 {
        value[key]
            .as_i64()
            .unwrap_or_else(|| panic!("{key} must be an integer, is {}", value[key]))
    }

    fn optional_date(value: &Value) -> Option<Date> {
        value.as_str().map(date)
    }

    /// A fixture's `daily_demand`: quantities, or `[quantity, days]` runs.
    fn series(value: &Value) -> Vec<i64> {
        let mut out = Vec::new();
        for entry in value.as_array().expect("daily_demand is an array") {
            match entry {
                Value::Array(run) => {
                    let quantity = run[0].as_i64().expect("a run's quantity");
                    let days = run[1]
                        .as_u64()
                        .and_then(|days| usize::try_from(days).ok())
                        .expect("a run's length");
                    out.extend(std::iter::repeat_n(quantity, days));
                }
                quantity => out.push(quantity.as_i64().expect("a quantity")),
            }
        }
        out
    }

    fn input_from(value: &Value) -> EngineInput {
        let rule = &value["rule"];
        let rule = match rule["method"].as_str() {
            Some("auto") => RuleMethod::Auto,
            Some("min_max") => RuleMethod::MinMax {
                min: int(rule, "min"),
                max: int(rule, "max"),
            },
            Some("off") => RuleMethod::Off,
            other => panic!("unknown rule {other:?}"),
        };
        let supplier = match &value["supplier"] {
            Value::Null => None,
            terms => Some(SupplierTerms {
                min_order_qty: terms["min_order_qty"].as_i64(),
                order_multiple: int(terms, "order_multiple"),
                unit_cost: terms["unit_cost"].as_f64(),
            }),
        };
        let position = &value["position"];
        EngineInput {
            today: date(value["today"].as_str().expect("today")),
            history_start: date(value["history_start"].as_str().expect("history_start")),
            daily_demand: series(&value["daily_demand"]),
            first_activity: optional_date(&value["first_activity"]),
            lead_time_days: int(value, "lead_time_days"),
            review_period_days: int(value, "review_period_days"),
            service_level: value["service_level"].as_f64().expect("service_level"),
            rule,
            supplier,
            position: Position {
                on_hand: int(position, "on_hand"),
                allocated: int(position, "allocated"),
                incoming: int(position, "incoming"),
                open_demand: int(position, "open_demand"),
            },
            receipts: value["receipts"]
                .as_array()
                .expect("receipts is an array")
                .iter()
                .map(|receipt| ExpectedReceipt {
                    date: date(receipt["date"].as_str().expect("a receipt's date")),
                    quantity: int(receipt, "quantity"),
                })
                .collect(),
        }
    }

    /// Numbers match within `tolerance` (relative above 1), everything else exactly.
    fn matches(expected: &Value, actual: &Value, tolerance: f64) -> bool {
        match (expected, actual) {
            (Value::Number(expected), Value::Number(actual)) => {
                let (expected, actual) = (
                    expected.as_f64().unwrap_or(f64::NAN),
                    actual.as_f64().unwrap_or(f64::NAN),
                );
                (expected - actual).abs() <= tolerance * expected.abs().max(1.0)
            }
            (Value::Array(expected), Value::Array(actual)) => {
                expected.len() == actual.len()
                    && expected
                        .iter()
                        .zip(actual)
                        .all(|(expected, actual)| matches(expected, actual, tolerance))
            }
            (Value::Object(expected), Value::Object(actual)) => {
                expected.len() == actual.len()
                    && expected.iter().all(|(key, expected)| {
                        actual
                            .get(key)
                            .is_some_and(|actual| matches(expected, actual, tolerance))
                    })
            }
            _ => expected == actual,
        }
    }

    fn number(value: Option<f64>) -> Value {
        value.map_or(Value::Null, Value::from)
    }

    fn quantity(value: Option<i64>) -> Value {
        value.map_or(Value::Null, Value::from)
    }

    /// The output in the fixtures' shape; `daily_forecast` as its length and
    /// the days the fixture samples.
    fn actual_fields(out: &EngineOutput, expected: &Value) -> Vec<(&'static str, Value)> {
        let samples: Map<String, Value> = expected["daily_forecast"]["at"]
            .as_object()
            .map(|at| {
                at.keys()
                    .map(|day| {
                        let value = day
                            .parse::<usize>()
                            .ok()
                            .and_then(|day| out.daily_forecast.get(day).copied());
                        (day.clone(), number(value))
                    })
                    .collect()
            })
            .unwrap_or_default();
        vec![
            ("method", Value::from(out.method.as_str())),
            ("confidence", Value::from(out.confidence.as_str())),
            ("history_days", Value::from(out.history_days)),
            ("nonzero_days", Value::from(out.nonzero_days)),
            ("avg_daily_demand", number(out.avg_daily_demand)),
            ("demand_std_dev", number(out.demand_std_dev)),
            (
                "seasonality",
                out.seasonality
                    .map_or(Value::Null, |indices| Value::from(indices.to_vec())),
            ),
            ("forecast_30d", number(out.forecast_30d)),
            ("forecast_90d", number(out.forecast_90d)),
            ("safety_stock", quantity(out.safety_stock)),
            ("reorder_point", quantity(out.reorder_point)),
            ("order_up_to", quantity(out.order_up_to)),
            ("inventory_position", Value::from(out.inventory_position)),
            ("days_of_cover", number(out.days_of_cover)),
            (
                "stockout_date",
                out.stockout_date
                    .map_or(Value::Null, |date| Value::from(iso(date))),
            ),
            ("suggested_qty", Value::from(out.suggested_qty)),
            ("suggested_value", number(out.suggested_value)),
            (
                "daily_forecast",
                json!({ "len": out.daily_forecast.len(), "at": samples }),
            ),
        ]
    }

    fn check_fixture(name: &str, text: &str) {
        let fixture: Value =
            serde_json::from_str(text).unwrap_or_else(|error| panic!("{name}: {error}"));
        let tolerance = fixture["tolerance"].as_f64().unwrap_or(1e-6);
        let expected = &fixture["expected"];
        let out = plan_item(&input_from(&fixture["input"]));
        let fields = actual_fields(&out, expected);
        let mut problems: Vec<String> = fields
            .iter()
            .filter_map(|(field, actual)| match expected.get(*field) {
                None => Some(format!("{field}: missing from the fixture")),
                Some(want) if !matches(want, actual, tolerance) => {
                    Some(format!("{field}: expected {want}, got {actual}"))
                }
                Some(_) => None,
            })
            .collect();
        if let Some(keys) = expected.as_object() {
            problems.extend(
                keys.keys()
                    .filter(|key| fields.iter().all(|(field, _)| field != key))
                    .map(|key| format!("{key}: not an engine output")),
            );
        }
        assert!(
            problems.is_empty(),
            "fixture {name}:\n  {}",
            problems.join("\n  ")
        );
    }

    macro_rules! golden {
        ($($name:ident),* $(,)?) => {
            $(
                #[test]
                fn $name() {
                    super::check_fixture(
                        stringify!($name),
                        include_str!(concat!("fixtures/", stringify!($name), ".json")),
                    );
                }
            )*
        };
    }

    /// The golden fixtures in `fixtures/`: input and expected output.
    mod golden {
        golden!(
            flat,
            trend,
            december_peak,
            sparse,
            new_product,
            min_max,
            min_max_new_product,
            off,
            pack_rounding,
            moq,
            receipts_prevent_stockout,
            zero_lead_time,
            all_zero,
        );
    }

    fn close(actual: f64, expected: f64, tolerance: f64) -> bool {
        (actual - expected).abs() <= tolerance
    }

    /// A flat item: `quantity` a day for `days` days up to yesterday.
    fn flat_item(today: Date, days: i64, quantity: i64) -> EngineInput {
        let history_start = today - Duration::days(days);
        EngineInput {
            today,
            history_start,
            daily_demand: vec![quantity; usize::try_from(days).expect("days")],
            first_activity: Some(history_start),
            lead_time_days: 14,
            review_period_days: 7,
            service_level: 0.95,
            rule: RuleMethod::Auto,
            supplier: None,
            position: Position::default(),
            receipts: Vec::new(),
        }
    }

    /// Days from `start` on, with a quantity per month (0 = January).
    fn days_from(start: Date, count: usize, per_month: impl Fn(usize) -> f64) -> Vec<Day> {
        let mut days = Vec::with_capacity(count);
        let mut date = start;
        for _ in 0..count {
            let month = month_index(date);
            days.push(Day {
                quantity: per_month(month),
                month,
            });
            date = date.next_day().expect("a next day");
        }
        days
    }

    #[test]
    fn z_matches_the_normal_table() {
        for (p, z) in [
            (0.5, 0.0),
            (0.90, 1.281_552),
            (0.95, 1.644_854),
            (0.975, 1.959_964),
            (0.98, 2.053_749),
            (0.99, 2.326_348),
            (0.999, 3.090_232),
        ] {
            let got = inverse_normal_cdf(p);
            assert!(close(got, z, 1e-6), "Φ⁻¹({p}) = {got}, table {z}");
        }
    }

    #[test]
    fn z_mirrors_in_the_lower_tail() {
        for p in [0.001, 0.01, 0.02, 0.05, 0.1, 0.3] {
            let lower = inverse_normal_cdf(p);
            let upper = inverse_normal_cdf(1.0 - p);
            assert!(
                close(lower, -upper, 1e-8),
                "Φ⁻¹({p}) = {lower}, Φ⁻¹(1 − p) = {upper}"
            );
        }
    }

    #[test]
    fn z_score_keeps_the_service_level_in_range() {
        assert!(close(z_score(0.3), 0.0, 1e-12));
        assert!(close(z_score(f64::NAN), 1.644_854, 1e-6));
        assert!(close(z_score(1.0), 3.090_232, 1e-6));
        assert!(close(z_score(f64::INFINITY), 3.090_232, 1e-6));
    }

    #[test]
    fn seasonality_shrinks_by_the_years_of_data() {
        // December at 30 a day, the rest at 10: mean(all) = 4270 / 365,
        // raw_Dec = 2.5644, raw_other = 0.8548.
        let december = |month: usize| if month == 11 { 30.0 } else { 10.0 };
        // One year: shrink 1/2 → 1.7822 and 0.9274, mean 0.99863.
        let one_year = days_from(date("2025-01-01"), 365, december);
        let indices = seasonal_indices(&one_year).expect("indices");
        assert!(
            close(indices[11], 1.784_639_437_170_217, 1e-9),
            "{indices:?}"
        );
        assert!(
            close(indices[0], 0.928_669_142_075_435, 1e-9),
            "{indices:?}"
        );
        // Two years: shrink 2/3 → 2.0429 and 0.9032, mean 0.99818.
        let two_years = days_from(date("2024-11-18"), 730, december);
        let indices = seasonal_indices(&two_years).expect("indices");
        assert!(
            close(indices[11], 2.046_663_190_823_775, 1e-9),
            "{indices:?}"
        );
        assert!(
            close(indices[5], 0.904_848_800_834_202, 1e-9),
            "{indices:?}"
        );
        assert!(close(indices.iter().sum::<f64>(), 12.0, 1e-9));
    }

    #[test]
    fn seasonality_clamps_then_renormalises() {
        // Only December sells: raw_Dec = 11.77 → 6.39 shrunk → 4 clamped;
        // the rest raw 0 → 0.5. Mean 9.5 / 12 → 5.0526 and 0.6316.
        let days = days_from(date("2025-01-01"), 365, |month| {
            if month == 11 { 100.0 } else { 0.0 }
        });
        let indices = seasonal_indices(&days).expect("indices");
        assert!(close(indices[11], 4.0 / (9.5 / 12.0), 1e-9), "{indices:?}");
        assert!(close(indices[3], 0.5 / (9.5 / 12.0), 1e-9), "{indices:?}");
        assert_eq!(
            seasonal_indices(&days_from(date("2025-01-01"), 365, |_| 0.0)),
            None
        );
        assert_eq!(seasonal_indices(&[]), None);
    }

    #[test]
    fn seasonality_needs_a_year_and_selling_days() {
        let today = date("2026-11-18");
        let short = plan_item(&flat_item(today, 364, 4));
        assert_eq!((short.method, short.seasonality), (PlanMethod::Level, None));
        let year = plan_item(&flat_item(today, 365, 4));
        assert_eq!(year.method, PlanMethod::Seasonal);
        assert!(year.seasonality.is_some());
        // A year with 5 selling days is sparse, without seasonality.
        let mut sparse = flat_item(today, 365, 0);
        for day in [10, 80, 150, 220, 300] {
            sparse.daily_demand[day] = 3;
        }
        let sparse = plan_item(&sparse);
        assert_eq!(
            (sparse.method, sparse.seasonality),
            (PlanMethod::Sparse, None)
        );
        assert_eq!(sparse.confidence, Confidence::Low);
    }

    #[test]
    fn rounds_up_to_packs_after_the_moq() {
        assert_eq!(round_order_qty(25, 0, 12), 36);
        assert_eq!(round_order_qty(24, 0, 12), 24);
        assert_eq!(round_order_qty(25, 48, 12), 48);
        // An MOQ that isn't a whole number of packs rounds up to one that is.
        assert_eq!(round_order_qty(24, 50, 12), 60);
        assert_eq!(round_order_qty(25, 0, 1), 25);
        assert_eq!(round_order_qty(7, 0, 0), 7);
        assert_eq!(round_order_qty(7, 0, -5), 7);
        assert_eq!(round_order_qty(7, -3, 1), 7);
        assert_eq!(round_order_qty(i64::MAX, i64::MAX, 1), MAX_QUANTITY);
        assert_eq!(
            round_order_qty(MAX_QUANTITY, 0, 1_000),
            MAX_QUANTITY / 1_000 * 1_000
        );
    }

    #[test]
    fn ceilings_ignore_float_noise() {
        assert_eq!(ceil_qty(70.000_000_000_000_01), 70);
        assert_eq!(ceil_qty(41.999_999_999_999_986), 42);
        assert_eq!(ceil_qty(1.093e-14), 0);
        assert_eq!(ceil_qty(70.1), 71);
        assert_eq!(ceil_qty(0.384), 1);
        assert_eq!(ceil_qty(-3.0), 0);
        assert_eq!(ceil_qty(f64::NAN), 0);
        assert_eq!(ceil_qty(f64::INFINITY), MAX_QUANTITY);
    }

    #[test]
    fn a_late_receipt_does_not_prevent_a_stockout() {
        // 4 a day from 20 available: day 5 needs 24. The 40 arrive on day 12.
        let today = date("2026-11-18");
        let mut input = flat_item(today, 100, 4);
        input.position.on_hand = 20;
        input.position.incoming = 40;
        input.receipts = vec![ExpectedReceipt {
            date: today + Duration::days(12),
            quantity: 40,
        }];
        let out = plan_item(&input);
        assert_eq!(out.stockout_date, Some(today + Duration::days(5)));
        // In time (day 3), the next shortfall is day 15 (64 > 60).
        input.receipts[0].date = today + Duration::days(3);
        let out = plan_item(&input);
        assert_eq!(out.stockout_date, Some(today + Duration::days(15)));
    }

    #[test]
    fn backorders_are_covered_without_demand() {
        // No sales in 200 days, 3 ordered today: the position is -3.
        let today = date("2026-11-18");
        let mut input = flat_item(today, 200, 0);
        input.position.open_demand = 3;
        let out = plan_item(&input);
        assert_eq!(out.method, PlanMethod::Sparse);
        assert_eq!((out.reorder_point, out.order_up_to), (Some(0), Some(0)));
        assert_eq!((out.inventory_position, out.suggested_qty), (-3, 3));
    }

    #[test]
    fn days_before_the_first_activity_are_not_zero_demand() {
        // A 365-day series for a product created 60 days ago that sold 6 a
        // day since: 60 days of history, level 6, not seasonal.
        let today = date("2026-11-18");
        let mut input = flat_item(today, 365, 0);
        input.first_activity = Some(today - Duration::days(60));
        for quantity in &mut input.daily_demand[305..] {
            *quantity = 6;
        }
        let out = plan_item(&input);
        assert_eq!(out.method, PlanMethod::Level);
        assert_eq!((out.history_days, out.nonzero_days), (60, 60));
        assert!(close(out.avg_daily_demand.expect("a level"), 6.0, 1e-9));
        assert_eq!(out.confidence, Confidence::Low);
        // A sale before the product's creation (an import) moves the start.
        input.daily_demand[100] = 2;
        let out = plan_item(&input);
        assert_eq!(out.history_days, 265);
    }

    #[test]
    fn an_empty_series_for_an_old_product_plans_nothing_to_order() {
        let today = date("2026-11-18");
        let mut input = flat_item(today, 0, 0);
        input.first_activity = Some(today - Duration::days(100));
        input.position.on_hand = 5;
        let out = plan_item(&input);
        assert_eq!(out.method, PlanMethod::Sparse);
        assert_eq!((out.history_days, out.suggested_qty), (0, 0));
        assert_eq!(out.avg_daily_demand, Some(0.0));
        assert_eq!((out.days_of_cover, out.stockout_date), (None, None));
        // Nothing at all: no plan.
        input.first_activity = None;
        let out = plan_item(&input);
        assert_eq!(
            (out.method, out.confidence),
            (PlanMethod::None, Confidence::None)
        );
    }

    fn assert_sane(out: &EngineOutput, case: &str) {
        let floats = [
            out.avg_daily_demand,
            out.demand_std_dev,
            out.forecast_30d,
            out.forecast_90d,
            out.days_of_cover,
            out.suggested_value,
        ];
        let seasonality = out.seasonality.unwrap_or([1.0; 12]);
        assert!(
            floats
                .iter()
                .flatten()
                .chain(&seasonality)
                .chain(&out.daily_forecast)
                .all(|value| value.is_finite()),
            "{case}: a value is not finite: {out:?}"
        );
        let quantities = [out.safety_stock, out.reorder_point, out.order_up_to];
        assert!(
            quantities
                .iter()
                .flatten()
                .chain([&out.inventory_position, &out.suggested_qty])
                .all(|quantity| quantity.abs() <= MAX_QUANTITY),
            "{case}: a quantity is out of range: {out:?}"
        );
        assert!(out.suggested_qty >= 0, "{case}: {out:?}");
        assert!(out.daily_forecast.len() <= FORECAST_DAYS, "{case}: {out:?}");
    }

    #[test]
    fn silly_inputs_stay_finite_and_bounded() {
        let today = date("2026-11-18");
        let mut huge = flat_item(today, 800, i64::MAX);
        huge.lead_time_days = i64::MAX;
        huge.review_period_days = i64::MIN;
        huge.service_level = f64::NAN;
        huge.supplier = Some(SupplierTerms {
            min_order_qty: Some(i64::MAX),
            order_multiple: 0,
            unit_cost: Some(f64::MAX),
        });
        huge.position = Position {
            on_hand: i64::MIN,
            allocated: i64::MAX,
            incoming: i64::MAX,
            open_demand: i64::MIN,
        };
        huge.receipts = vec![
            ExpectedReceipt {
                date: Date::MIN,
                quantity: i64::MAX,
            },
            ExpectedReceipt {
                date: Date::MAX,
                quantity: i64::MAX,
            },
        ];
        assert_sane(&plan_item(&huge), "huge numbers");

        let mut negative = flat_item(today, 90, -5);
        negative.lead_time_days = -3;
        negative.supplier = Some(SupplierTerms {
            min_order_qty: Some(-1),
            order_multiple: -12,
            unit_cost: Some(f64::NAN),
        });
        let out = plan_item(&negative);
        assert_sane(&out, "negative numbers");
        assert_eq!(
            (out.method, out.suggested_value),
            (PlanMethod::Sparse, None)
        );

        let mut edges = flat_item(today, 50, 3);
        edges.today = Date::MAX;
        edges.history_start = Date::MIN;
        edges.first_activity = Some(Date::MIN);
        assert_sane(&plan_item(&edges), "calendar edges");
        edges.today = Date::MIN;
        assert_sane(&plan_item(&edges), "today at the calendar's start");

        let mut rule = flat_item(today, 50, 3);
        rule.rule = RuleMethod::MinMax {
            min: i64::MIN,
            max: i64::MAX,
        };
        let out = plan_item(&rule);
        assert_sane(&out, "min/max extremes");
        assert_eq!(
            (out.reorder_point, out.order_up_to),
            (Some(0), Some(MAX_QUANTITY))
        );

        let mut spike = flat_item(today, 400, 0);
        spike.daily_demand[399] = i64::MAX;
        spike.daily_demand[10] = 1;
        assert_sane(&plan_item(&spike), "one huge day");
    }

    #[test]
    fn enum_values_match_the_columns() {
        let methods = [
            PlanMethod::Seasonal,
            PlanMethod::Level,
            PlanMethod::Sparse,
            PlanMethod::MinMax,
            PlanMethod::None,
        ]
        .map(PlanMethod::as_str);
        assert_eq!(methods, ["seasonal", "level", "sparse", "min_max", "none"]);
        let levels = [Confidence::None, Confidence::Low, Confidence::Ok].map(Confidence::as_str);
        assert_eq!(levels, ["none", "low", "ok"]);
    }
}
