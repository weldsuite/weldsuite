//! Latency percentiles, error tallies and a small deterministic RNG.

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

/// Microseconds, saturating.
pub(crate) fn micros(duration: Duration) -> u32 {
    u32::try_from(duration.as_micros()).unwrap_or(u32::MAX)
}

pub(crate) struct Percentiles {
    count: usize,
    p50: u32,
    p95: u32,
    p99: u32,
    p999: u32,
    max: u32,
}

impl Percentiles {
    pub(crate) fn of(samples: &mut [u32]) -> Self {
        samples.sort_unstable();
        let at = |permille: usize| -> u32 {
            if samples.is_empty() {
                return 0;
            }
            samples[(samples.len() * permille / 1000).min(samples.len() - 1)]
        };
        Self {
            count: samples.len(),
            p50: at(500),
            p95: at(950),
            p99: at(990),
            p999: at(999),
            max: samples.last().copied().unwrap_or(0),
        }
    }
}

fn ms(us: u32) -> String {
    format!("{}.{:02}", us / 1000, (us % 1000) / 10)
}

impl fmt::Display for Percentiles {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "n={} p50={}ms p95={}ms p99={}ms p99.9={}ms max={}ms",
            self.count,
            ms(self.p50),
            ms(self.p95),
            ms(self.p99),
            ms(self.p999),
            ms(self.max)
        )
    }
}

/// Error messages with each run of digits masked (`sqlx_s_17` and `sqlx_s_4` are
/// the same failure), counted.
#[derive(Default)]
pub(crate) struct Errors(BTreeMap<String, u64>);

impl Errors {
    pub(crate) fn add(&mut self, message: &str) {
        let mut masked = String::new();
        for c in message.chars().take(160) {
            if !c.is_ascii_digit() {
                masked.push(c);
            } else if !masked.ends_with('#') {
                masked.push('#');
            }
        }
        *self.0.entry(masked).or_default() += 1;
    }

    pub(crate) fn merge(&mut self, other: Self) {
        for (message, count) in other.0 {
            *self.0.entry(message).or_default() += count;
        }
    }

    pub(crate) fn total(&self) -> u64 {
        self.0.values().sum()
    }
}

impl fmt::Display for Errors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (message, count) in &self.0 {
            writeln!(f, "    {count:>7}  {message}")?;
        }
        Ok(())
    }
}

/// xorshift64*: enough randomness for load shapes, no dependency.
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in `0..n` (`n > 0`).
    pub(crate) fn below(&mut self, n: usize) -> usize {
        let n64 = u64::try_from(n).unwrap_or(u64::MAX);
        usize::try_from(self.next_u64() % n64).unwrap_or(0)
    }

    /// Uniform in `[0, 1)`.
    pub(crate) fn unit(&mut self) -> f64 {
        f64::from(u32::try_from(self.next_u64() >> 32).unwrap_or(u32::MAX)) / 4_294_967_296.0
    }
}

/// Zipf(s = 1) over `0..n`: rank 0 is the busiest.
pub(crate) struct Zipf(Vec<f64>);

impl Zipf {
    pub(crate) fn new(n: u32) -> Self {
        let mut cdf = Vec::new();
        let mut total = 0.0;
        for rank in 1..=n {
            total += 1.0 / f64::from(rank);
            cdf.push(total);
        }
        for value in &mut cdf {
            *value /= total;
        }
        Self(cdf)
    }

    pub(crate) fn sample(&self, rng: &mut Rng) -> usize {
        let u = rng.unit();
        self.0.partition_point(|&c| c < u).min(self.0.len() - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_and_masking() {
        let mut samples: Vec<u32> = (1..=1000).collect();
        let p = Percentiles::of(&mut samples);
        assert_eq!((p.p50, p.p99, p.max), (501, 991, 1000));
        let mut errors = Errors::default();
        errors.add("prepared statement \"sqlx_s_17\" does not exist");
        errors.add("prepared statement \"sqlx_s_4\" does not exist");
        assert_eq!(errors.total(), 2);
        assert_eq!(errors.0.len(), 1);
    }

    #[test]
    fn zipf_favours_low_ranks() {
        let zipf = Zipf::new(300);
        let mut rng = Rng::new(7);
        let hits = (0..10_000).filter(|_| zipf.sample(&mut rng) < 30).count();
        // The top 10% of 300 ranks carries about 60% of Zipf(1) traffic.
        assert!((5_000..7_000).contains(&hits), "{hits}");
    }
}
