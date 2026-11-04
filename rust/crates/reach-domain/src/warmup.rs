//! `warmup.ts`: the numbers reach-api and the warmup worker agree on (ramp,
//! health gate, pool minimum). Pure.

pub const WARMUP_MIN_DAYS: i64 = 14;
pub const WARMUP_MIN_INBOX_RATE: f64 = 0.85;
pub const WARMUP_GATE_WINDOW_DAYS: i64 = 3;
pub const WARMUP_MIN_SAMPLE: i64 = 10;
pub const WARMUP_MIN_POOL_DOMAINS: i64 = 3;
pub const WARMUP_RAMP_START: i64 = 2;
pub const WARMUP_RAMP_MAX: i64 = 40;
pub const WARMUP_MAINTAIN_MIN: i64 = 10;
pub const WARMUP_MAINTAIN_MAX: i64 = 15;
pub const WARMUP_REPLY_RATE_MIN: f64 = 0.3;
pub const WARMUP_REPLY_RATE_MAX: f64 = 0.45;
pub const WARMUP_CLEANUP_AFTER_DAYS: i64 = 14;

/// `warmupRampTarget(rampDay)`.
pub fn ramp_target(ramp_day: i64) -> i64 {
    if ramp_day <= 0 {
        return 0;
    }
    if ramp_day >= WARMUP_MIN_DAYS {
        return WARMUP_RAMP_MAX;
    }
    let step = (WARMUP_RAMP_MAX - WARMUP_RAMP_START) as f64 / (WARMUP_MIN_DAYS - 1) as f64;
    (WARMUP_RAMP_START as f64 + step * (ramp_day - 1) as f64 + 0.5).floor() as i64
}

/// `inboxRate(counts)`: `None` below the minimum sample.
pub fn inbox_rate(inbox: i64, spam: i64, missing: i64) -> Option<f64> {
    let judged = inbox + spam + missing;
    (judged >= WARMUP_MIN_SAMPLE).then(|| inbox as f64 / judged as f64)
}

/// `warmupGate(input)`: `None` when ready, else the reason.
pub fn gate(
    ramp_day: i64,
    inbox_rate_3d: Option<f64>,
    has_login_error: bool,
) -> Option<&'static str> {
    if has_login_error {
        return Some("login_error");
    }
    if ramp_day < WARMUP_MIN_DAYS {
        return Some("too_early");
    }
    match inbox_rate_3d {
        None => Some("not_enough_data"),
        Some(rate) if rate < WARMUP_MIN_INBOX_RATE => Some("low_inbox_rate"),
        Some(_) => None,
    }
}

/// `domainOf(email)`.
pub fn domain_of(email: &str) -> String {
    crate::schemas::email_domain(email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramp_and_gate() {
        assert_eq!(ramp_target(0), 0);
        assert_eq!(ramp_target(1), 2);
        assert_eq!(ramp_target(14), 40);
        assert_eq!(ramp_target(7), 20);
        assert_eq!(gate(14, Some(0.9), false), None);
        assert_eq!(gate(3, Some(0.9), false), Some("too_early"));
        assert_eq!(gate(20, None, true), Some("login_error"));
    }
}
