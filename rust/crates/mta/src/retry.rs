//! When a deferred recipient is tried again: 5m, 15m, 30m, 1h, 2h, 4h, then
//! every 6h, until the message is older than `MTA_MAX_QUEUE_AGE` (then it
//! bounces as expired). A little jitter keeps a burst of deferrals from
//! retrying in lockstep.

use std::time::Duration;

const STEPS: &[u64] = &[300, 900, 1800, 3600, 7200, 14_400];
const STEADY: u64 = 21_600;

/// The delay before attempt `attempts + 1`, `attempts` having failed.
pub fn delay(attempts: u32) -> Duration {
    let index = usize::try_from(attempts.saturating_sub(1)).unwrap_or(usize::MAX);
    let base = STEPS.get(index).copied().unwrap_or(STEADY);
    let mut bytes = [0u8; 2];
    let _ = aws_lc_rs::rand::fill(&mut bytes);
    // Up to +10%.
    let jitter = base * u64::from(u16::from_be_bytes(bytes) % 100) / 1000;
    Duration::from_secs(base + jitter)
}

/// Whether a message received `age` ago has run out of retries.
pub fn expired(age: Duration, max_age: Duration) -> bool {
    age >= max_age
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_then_settles() {
        assert!((300..=330).contains(&delay(1).as_secs()));
        assert!((900..=990).contains(&delay(2).as_secs()));
        assert!((14_400..=15_840).contains(&delay(6).as_secs()));
        assert!((21_600..=23_760).contains(&delay(40).as_secs()));
        assert!((300..=330).contains(&delay(0).as_secs()));
        assert!(expired(Duration::from_secs(10), Duration::from_secs(10)));
        assert!(!expired(Duration::from_secs(9), Duration::from_secs(10)));
    }
}
