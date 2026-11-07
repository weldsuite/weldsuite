//! Traffic shaping per node: the big mailbox providers throttle new or fast
//! senders, so each gets its own connection and per-minute limits, picked
//! from the MX host name (Gmail and Google Workspace share Google's MXs,
//! Outlook.com and Microsoft 365 share EOP's). Everything else is limited per
//! destination domain. The per-IP daily warm-up cap is in the store
//! (`ip_usage`), shared by every process that sends from the IP.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Google,
    Microsoft,
    Yahoo,
    Apple,
    /// GMX, Web.de, mail.com (United Internet).
    UnitedInternet,
    Other,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Microsoft => "microsoft",
            Self::Yahoo => "yahoo",
            Self::Apple => "apple",
            Self::UnitedInternet => "united-internet",
            Self::Other => "other",
        }
    }

    /// (concurrent connections, messages per minute) per node.
    fn limits(self) -> (usize, u32) {
        match self {
            Self::Google => (4, 60),
            Self::Microsoft | Self::Yahoo | Self::Apple | Self::UnitedInternet => (2, 30),
            Self::Other => (2, 600),
        }
    }
}

/// The provider behind an MX host.
pub fn classify(mx_host: &str) -> Provider {
    let host = mx_host.trim_end_matches('.').to_ascii_lowercase();
    let ends = |suffix: &str| host == suffix || host.ends_with(&format!(".{suffix}"));
    if ends("google.com") || ends("googlemail.com") {
        Provider::Google
    } else if ends("outlook.com") || ends("hotmail.com") {
        Provider::Microsoft
    } else if ends("yahoodns.net") || ends("yahoo.com") || ends("aol.com") {
        Provider::Yahoo
    } else if ends("icloud.com") || ends("me.com") || ends("apple.com") {
        Provider::Apple
    } else if ends("gmx.net") || ends("web.de") || ends("mail.com") || ends("gmx.com") {
        Provider::UnitedInternet
    } else {
        Provider::Other
    }
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    capacity: f64,
    per_second: f64,
    at: Instant,
}

impl Bucket {
    fn new(per_minute: u32) -> Self {
        let capacity = f64::from(per_minute.max(1)) / 4.0;
        Self {
            tokens: capacity,
            capacity,
            per_second: f64::from(per_minute) / 60.0,
            at: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = (self.tokens + elapsed * self.per_second).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

type Gate = (Arc<Semaphore>, Arc<Mutex<Bucket>>);

/// The limits of one node.
#[derive(Debug, Default)]
pub struct Shaper {
    gates: Mutex<HashMap<String, Gate>>,
}

/// Held while a connection to the destination is open.
#[derive(Debug)]
pub struct Slot {
    _permit: OwnedSemaphorePermit,
    bucket: Arc<Mutex<Bucket>>,
}

impl Slot {
    /// One message's worth of the per-minute budget; `false` when spent.
    pub fn take_message(&self) -> bool {
        self.bucket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

impl Shaper {
    pub fn new() -> Self {
        Self::default()
    }

    fn gate(&self, provider: Provider, domain: &str) -> Gate {
        let key = match provider {
            Provider::Other => format!("domain:{domain}"),
            known => format!("provider:{}", known.name()),
        };
        let mut gates = self.gates.lock().unwrap_or_else(PoisonError::into_inner);
        if gates.len() > 10_000 {
            // Drop idle per-domain gates.
            gates.retain(|_, (semaphore, _)| {
                semaphore.available_permits() < provider.limits().0
                    || Arc::strong_count(semaphore) > 1
            });
        }
        let (connections, per_minute) = provider.limits();
        let (semaphore, bucket) = gates.entry(key).or_insert_with(|| {
            (
                Arc::new(Semaphore::new(connections)),
                Arc::new(Mutex::new(Bucket::new(per_minute))),
            )
        });
        (Arc::clone(semaphore), Arc::clone(bucket))
    }

    /// A connection slot to `domain` behind `provider`, if one is free now.
    pub fn try_connect(&self, provider: Provider, domain: &str) -> Option<Slot> {
        let (semaphore, bucket) = self.gate(provider, domain);
        semaphore.try_acquire_owned().ok().map(|permit| Slot {
            _permit: permit,
            bucket,
        })
    }
}

/// The warm-up cap for an IP on its `day`th day of sending (1-based); `None`
/// means no cap.
pub fn warmup_cap(schedule: &[u32], day: u32) -> Option<u32> {
    if schedule.is_empty() {
        return None;
    }
    let index = usize::try_from(day.saturating_sub(1)).unwrap_or(usize::MAX);
    schedule.get(index).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_mx_hosts() {
        assert_eq!(classify("gmail-smtp-in.l.google.com."), Provider::Google);
        assert_eq!(classify("aspmx.l.google.com"), Provider::Google);
        assert_eq!(
            classify("acme-eu.mail.protection.outlook.com"),
            Provider::Microsoft
        );
        assert_eq!(classify("mta5.am0.yahoodns.net"), Provider::Yahoo);
        assert_eq!(classify("mx01.mail.icloud.com"), Provider::Apple);
        assert_eq!(classify("mx00.emig.gmx.net"), Provider::UnitedInternet);
        assert_eq!(classify("mx.notgoogle.com"), Provider::Other);
    }

    #[test]
    fn limits_connections_and_rate() {
        let shaper = Shaper::new();
        let a = shaper.try_connect(Provider::Microsoft, "x").expect("first");
        let _b = shaper
            .try_connect(Provider::Microsoft, "y")
            .expect("second");
        assert!(shaper.try_connect(Provider::Microsoft, "z").is_none());
        drop(a);
        let slot = shaper.try_connect(Provider::Microsoft, "z").expect("freed");
        // 30/min: a burst of 7 (a quarter minute), then empty.
        let taken = (0..20).filter(|_| slot.take_message()).count();
        assert_eq!(taken, 7);
        // Other destinations are limited per domain.
        let _c = shaper.try_connect(Provider::Other, "a.test").expect("a");
        let _d = shaper.try_connect(Provider::Other, "a.test").expect("a2");
        assert!(shaper.try_connect(Provider::Other, "a.test").is_none());
        assert!(shaper.try_connect(Provider::Other, "b.test").is_some());
    }

    #[test]
    fn reads_the_warmup_schedule() {
        let schedule = [50, 100];
        assert_eq!(warmup_cap(&schedule, 1), Some(50));
        assert_eq!(warmup_cap(&schedule, 2), Some(100));
        assert_eq!(warmup_cap(&schedule, 3), None);
        assert_eq!(warmup_cap(&[], 1), None);
    }
}
