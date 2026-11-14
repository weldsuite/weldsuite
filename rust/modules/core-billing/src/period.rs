//! Billing periods, the monthly anchor and proration (ADR BILL-014).
//!
//! A workspace is charged on one day of the month, its anchor: the day it
//! first paid, capped at 28 so every month has it. Periods run from anchor
//! to anchor at the time of day of the first payment: a monthly plan for one
//! month, a yearly plan for twelve. The renewal job charges on every anchor
//! (the plan when its period ends, the monthly add-ons always) and grants
//! the plan's monthly credits on each.
//!
//! Proration counts whole days in UTC, today included: 3 → 5 seats on day
//! 11 of a 30-day period bills 20 of 30 days. Each amount is rounded half up
//! to the cent before VAT.

use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, UtcOffset};

/// The billing cycle of a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cycle {
    Monthly,
    Yearly,
}

impl Cycle {
    /// From `workspaces.subscription_cycle` / the checkout body: `monthly`,
    /// `yearly` (and Stripe's `annually`).
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "monthly" | "month" => Some(Self::Monthly),
            "yearly" | "year" | "annually" | "annual" => Some(Self::Yearly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }

    /// The interval `/api/billing/seat-price` reports.
    pub fn interval(self) -> &'static str {
        match self {
            Self::Monthly => "month",
            Self::Yearly => "year",
        }
    }

    pub fn months(self) -> i32 {
        match self {
            Self::Monthly => 1,
            Self::Yearly => 12,
        }
    }
}

/// `new Date().toISOString()`: UTC with milliseconds, as Drizzle writes a
/// `timestamp`. Bind it as text with `::timestamp`.
pub fn iso(at: OffsetDateTime) -> String {
    weldsuite_events::iso_timestamp(at)
}

/// Reads an ISO 8601 / RFC 3339 instant, or a `timestamp` column read as
/// text (`2026-11-14 10:00:00.123`, taken as UTC).
pub fn parse_iso(text: &str) -> Option<OffsetDateTime> {
    let text = text.trim();
    if let Ok(at) = OffsetDateTime::parse(text, &Rfc3339) {
        return Some(at.to_offset(UtcOffset::UTC));
    }
    let normalized = text.replace(' ', "T");
    let with_zone = if normalized.ends_with('Z') || normalized.contains('+') {
        normalized
    } else {
        format!("{normalized}Z")
    };
    OffsetDateTime::parse(&with_zone, &Rfc3339)
        .ok()
        .map(|at| at.to_offset(UtcOffset::UTC))
}

/// The anchor day for a first payment on `paid_at`: its day, at most 28.
pub fn anchor_day(paid_at: OffsetDateTime) -> u8 {
    paid_at.day().min(28)
}

/// `months` months after `from`, on day `anchor_day` (1–28), at `from`'s
/// time of day.
pub fn add_months_on_anchor(from: OffsetDateTime, months: i32, anchor_day: u8) -> OffsetDateTime {
    let from = from.to_offset(UtcOffset::UTC);
    let index = from.year() * 12 + i32::from(u8::from(from.month())) - 1 + months;
    let year = index.div_euclid(12);
    let month = u8::try_from(index.rem_euclid(12) + 1).unwrap_or(1);
    let month = Month::try_from(month).unwrap_or(Month::January);
    let day = anchor_day.clamp(1, 28);
    let date = Date::from_calendar_date(year, month, day).unwrap_or_else(|_| from.date());
    PrimitiveDateTime::new(date, from.time()).assume_utc()
}

/// The period a first payment on `paid_at` buys: from then until the
/// anchor `cycle` later.
pub fn first_period(paid_at: OffsetDateTime, cycle: Cycle) -> (OffsetDateTime, OffsetDateTime) {
    let anchor = anchor_day(paid_at);
    (
        paid_at,
        add_months_on_anchor(paid_at, cycle.months(), anchor),
    )
}

/// Whole UTC days from `start`'s date to `end`'s.
fn days_between(start: OffsetDateTime, end: OffsetDateTime) -> i64 {
    (end.to_offset(UtcOffset::UTC).date() - start.to_offset(UtcOffset::UTC).date()).whole_days()
}

/// The part of `amount` (cents, for the whole period `start..end`) left
/// from `now` to the period end, today included, rounded half up. Nothing
/// once the period is over; the whole amount before it starts.
pub fn prorate(
    amount: i64,
    start: OffsetDateTime,
    end: OffsetDateTime,
    now: OffsetDateTime,
) -> i64 {
    let total = days_between(start, end);
    if total <= 0 || amount <= 0 {
        return 0;
    }
    let left = days_between(now, end).clamp(0, total);
    (amount * left + total / 2) / total
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn anchors_cap_at_28_and_keep_the_time_of_day() {
        let paid = datetime!(2026-01-30 15:20:00 UTC);
        assert_eq!(anchor_day(paid), 28);
        let (start, end) = first_period(paid, Cycle::Monthly);
        assert_eq!(start, paid);
        assert_eq!(end, datetime!(2026-02-28 15:20:00 UTC));
        assert_eq!(
            add_months_on_anchor(end, 1, 28),
            datetime!(2026-03-28 15:20:00 UTC)
        );
        let (_, year_end) = first_period(datetime!(2026-11-14 09:00:00 UTC), Cycle::Yearly);
        assert_eq!(year_end, datetime!(2027-11-14 09:00:00 UTC));
        assert_eq!(
            add_months_on_anchor(datetime!(2026-12-14 09:00:00 UTC), 1, 14),
            datetime!(2027-01-14 09:00:00 UTC)
        );
    }

    #[test]
    fn proration_counts_days_left_today_included() {
        // The plan's example: 2 seats × €49 on day 11 of a 30-day period.
        let start = datetime!(2026-11-01 08:00:00 UTC);
        let end = datetime!(2026-12-01 08:00:00 UTC);
        let now = datetime!(2026-11-11 17:45:00 UTC);
        assert_eq!(prorate(2 * 4900, start, end, now), 6533);
        // On the first day: everything; after the end: nothing.
        assert_eq!(prorate(4900, start, end, start), 4900);
        assert_eq!(
            prorate(4900, start, end, datetime!(2026-12-02 00:00:00 UTC)),
            0
        );
        assert_eq!(prorate(0, start, end, now), 0);
    }

    #[test]
    fn reads_iso_and_timestamp_text() {
        let at = datetime!(2026-11-14 10:00:00.123 UTC);
        assert_eq!(parse_iso(&iso(at)), Some(at));
        assert_eq!(parse_iso("2026-11-14 10:00:00.123"), Some(at));
        assert_eq!(
            parse_iso("2026-11-14T11:00:00+01:00"),
            Some(datetime!(2026-11-14 10:00:00 UTC))
        );
        assert_eq!(parse_iso("not a date"), None);
        assert_eq!(Cycle::parse("annually"), Some(Cycle::Yearly));
        assert_eq!(Cycle::parse("weekly"), None);
    }
}
