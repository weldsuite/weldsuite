//! `lib/random.ts`, `lib/time.ts` and `schedule.ts` of reach-warmup-worker:
//! randomness through an injectable source, a mailbox's business hours
//! (09:00-17:30 local, Monday to Friday) and the day's send times. Times are
//! epoch milliseconds, as JavaScript's `Date` holds them. Pure.

use jiff::tz::TimeZone;
use weldsuite_reach_domain::send_window::{time_zone, utc_ms, zoned_parts_ms};
use weldsuite_reach_domain::warmup::{WARMUP_MAINTAIN_MAX, WARMUP_MAINTAIN_MIN, ramp_target};

pub const MINUTE_MS: i64 = 60_000;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
pub const DAY_MS: i64 = 24 * HOUR_MS;

/// A uniform source in [0, 1) (`Rng`): the OS in production, a script in
/// tests.
pub type Rng<'a> = &'a mut (dyn FnMut() -> f64 + Send);

/// `randomFloat()`: uniform in [0, 1) from the OS's generator.
pub fn random_float() -> f64 {
    let mut word = [0u8; 4];
    if getrandom::fill(&mut word).is_err() {
        return 0.0;
    }
    f64::from(u32::from_le_bytes(word)) / 4_294_967_296.0
}

/// `randomBetween(rng, min, max)`.
pub fn random_between(rng: Rng<'_>, min: f64, max: f64) -> f64 {
    min + rng() * (max - min)
}

/// `randomInt(rng, min, max)`, both inclusive.
pub fn random_int(rng: Rng<'_>, min: i64, max: i64) -> i64 {
    min + (rng() * (max - min + 1) as f64).floor() as i64
}

/// `chance(rng, probability)`.
pub fn chance(rng: Rng<'_>, probability: f64) -> bool {
    rng() < probability
}

/// `shuffled(rng, items)`: Fisher-Yates on a copy.
pub fn shuffled<T: Clone>(rng: Rng<'_>, items: &[T]) -> Vec<T> {
    let mut out = items.to_vec();
    for i in (1..out.len()).rev() {
        let j = (rng() * (i + 1) as f64).floor() as usize;
        out.swap(i, j.min(i));
    }
    out
}

/// `Math.round(x)`.
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// `new Date(x).getTime()` of a fractional millisecond count.
pub fn js_date(ms: f64) -> i64 {
    ms.trunc() as i64
}

pub const DEFAULT_TIMEZONE: &str = "Europe/Amsterdam";
/// 09:00 and 17:30 local, in minutes after midnight.
pub const BUSINESS_START_MINUTE: i64 = 9 * 60;
pub const BUSINESS_END_MINUTE: i64 = 17 * 60 + 30;

/// `safeTimeZone(timeZone)`: the zone, else the default.
fn zone_of(name: &str) -> TimeZone {
    time_zone(name)
        .or_else(|| time_zone(DEFAULT_TIMEZONE))
        .unwrap_or(TimeZone::UTC)
}

/// `LocalParts`; `weekday` 0 = Sunday.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalParts {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub date: String,
    pub weekday: i64,
}

/// `formatDate(year, month, day)`.
pub fn format_date(year: i64, month: i64, day: i64) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// `weekdayOf(year, month, day)`: 0 = Sunday.
pub fn weekday_of(year: i64, month: i64, day: i64) -> i64 {
    // 1970-01-01 was a Thursday.
    (utc_ms(year, month, day, 0, 0, 0).div_euclid(DAY_MS) + 4).rem_euclid(7)
}

/// `localParts(at, timeZone)`.
pub fn local_parts(at: i64, timezone: &str) -> LocalParts {
    let p = zoned_parts_ms(at, &zone_of(timezone));
    LocalParts {
        year: p.year,
        month: p.month,
        day: p.day,
        hour: p.hour,
        minute: p.minute,
        second: p.second,
        date: format_date(p.year, p.month, p.day),
        weekday: weekday_of(p.year, p.month, p.day),
    }
}

/// `localDate(at, timeZone)`.
pub fn local_date(at: i64, timezone: &str) -> String {
    local_parts(at, timezone).date
}

/// `isWeekday(weekday)`.
pub fn is_weekday(weekday: i64) -> bool {
    (1..=5).contains(&weekday)
}

fn date_parts(date: &str) -> (i64, i64, i64) {
    let mut parts = date.split('-').map(|p| p.parse::<i64>().unwrap_or(0));
    (
        parts.next().unwrap_or(1970),
        parts.next().unwrap_or(1),
        parts.next().unwrap_or(1),
    )
}

/// `offsetAt(ts, timeZone)`.
fn offset_at(ts: i64, timezone: &str) -> i64 {
    let p = local_parts(ts, timezone);
    utc_ms(p.year, p.month, p.day, p.hour, p.minute, p.second) - ts.div_euclid(1000) * 1000
}

/// `zonedTimeToUtc(date, minuteOfDay, timeZone)`.
pub fn zoned_time_to_utc(date: &str, minute_of_day: i64, timezone: &str) -> i64 {
    let (year, month, day) = date_parts(date);
    let naive = utc_ms(year, month, day, 0, minute_of_day, 0);
    let first = naive - offset_at(naive, timezone);
    naive - offset_at(first, timezone)
}

/// `addDays(date, days)`.
pub fn add_days(date: &str, days: i64) -> String {
    let (year, month, day) = date_parts(date);
    let p = zoned_parts_ms(utc_ms(year, month, day + days, 0, 0, 0), &TimeZone::UTC);
    format_date(p.year, p.month, p.day)
}

/// `BusinessWindow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessWindow {
    pub date: String,
    pub business_day: bool,
    pub start: i64,
    pub end: i64,
}

/// `businessWindowOn(date, timeZone)`.
pub fn business_window_on(date: &str, timezone: &str) -> BusinessWindow {
    let (year, month, day) = date_parts(date);
    BusinessWindow {
        date: date.to_owned(),
        business_day: is_weekday(weekday_of(year, month, day)),
        start: zoned_time_to_utc(date, BUSINESS_START_MINUTE, timezone),
        end: zoned_time_to_utc(date, BUSINESS_END_MINUTE, timezone),
    }
}

/// `businessWindow(at, timeZone)`.
pub fn business_window(at: i64, timezone: &str) -> BusinessWindow {
    business_window_on(&local_date(at, timezone), timezone)
}

/// `nextBusinessDate(date)`.
pub fn next_business_date(date: &str) -> String {
    let mut next = add_days(date, 1);
    for _ in 0..7 {
        let (year, month, day) = date_parts(&next);
        if is_weekday(weekday_of(year, month, day)) {
            break;
        }
        next = add_days(&next, 1);
    }
    next
}

const PUSHED_REPLY_SPREAD_MINUTES: f64 = 90.0;

/// `intoBusinessHours(at, timeZone, rng)`.
pub fn into_business_hours(at: i64, timezone: &str, rng: Rng<'_>) -> i64 {
    let window = business_window(at, timezone);
    if window.business_day && at >= window.start && at <= window.end {
        return at;
    }
    let spread = random_between(rng, 0.0, PUSHED_REPLY_SPREAD_MINUTES) * MINUTE_MS as f64;
    if window.business_day && at < window.start {
        return js_date(window.start as f64 + spread);
    }
    let next = business_window_on(&next_business_date(&window.date), timezone);
    js_date(next.start as f64 + spread)
}

// ---------------------------------------------------------------------------
// schedule.ts
// ---------------------------------------------------------------------------

pub const PLANNING_LEAD_MS: i64 = 2 * MINUTE_MS;
pub const MIN_GAP_MS: i64 = 45_000;
pub const SENDS_PER_THREAD: f64 = 1.6;

/// `newThreadsFor(totalSends)`.
pub fn new_threads_for(total_sends: i64) -> i64 {
    if total_sends <= 0 {
        return 0;
    }
    js_round(total_sends as f64 / SENDS_PER_THREAD).max(1)
}

/// `dailyTargetFor(status, rampDay, rng)`.
pub fn daily_target_for(maintaining: bool, ramp_day: i64, rng: Rng<'_>) -> i64 {
    if maintaining {
        return new_threads_for(random_int(rng, WARMUP_MAINTAIN_MIN, WARMUP_MAINTAIN_MAX));
    }
    new_threads_for(ramp_target(ramp_day))
}

/// `DayPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayPlan {
    pub count: i64,
    pub from: i64,
    pub until: i64,
}

/// `planDay(target, window, now)`.
pub fn plan_day(target: i64, window: &BusinessWindow, now: i64) -> DayPlan {
    let from = (now + PLANNING_LEAD_MS).max(window.start);
    if !window.business_day || target <= 0 || from >= window.end {
        return DayPlan {
            count: 0,
            from,
            until: window.end,
        };
    }
    let full = (window.end - window.start) as f64;
    let share = ((window.end - from) as f64 / full).min(1.0);
    let fits = (window.end - from).div_euclid(MIN_GAP_MS);
    DayPlan {
        count: js_round(target as f64 * share).min(fits),
        from,
        until: window.end,
    }
}

/// `spreadTimes(from, until, count, rng)`.
pub fn spread_times(from: i64, until: i64, count: i64, rng: Rng<'_>) -> Vec<i64> {
    if count <= 0 {
        return Vec::new();
    }
    let (start, end) = (from as f64, until as f64);
    let slot = (end - start) / count as f64;
    let mut previous = start - MIN_GAP_MS as f64;
    let mut times = Vec::with_capacity(usize::try_from(count).unwrap_or_default());
    for i in 0..count {
        let at = (start + slot * (i as f64 + rng()))
            .max(previous + MIN_GAP_MS as f64)
            .min(end);
        times.push(js_date(at));
        previous = at;
    }
    times
}
