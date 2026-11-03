//! `lib/visitor.ts` and the `PanelSalt` / `PanelUsage` Durable Objects.
//!
//! The cookieless visitor id (ADR PANEL-006):
//! `ck_` + the first 24 hex of SHA-256(`salt:projectId:ip:userAgent`), with a
//! random salt per UTC day that is deleted a day or two later, so an id
//! cannot be linked across days or recomputed from an IP and a user agent.
//!
//! On Global the salt lives in one global Durable Object; here it lives in
//! the cache ([`CacheSalt`]): the first pod that needs a day's salt claims
//! it with an atomic counter and writes it, the others read it, and it
//! expires a minute past the second midnight, as the object's alarm deletes
//! it. The daily event counts (`PanelUsage`) are atomic counters in the
//! cache too ([`CacheUsage`]).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use sha2::{Digest, Sha256};
use weldsuite_ports::{BoxFuture, Cache, DynCache, PortError};

use super::{SaltSource, UsageCounter};

/// Prefix of every cookieless id; ids a browser sends with consent never use it.
pub(crate) const COOKIELESS_PREFIX: &str = "ck_";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `utcDate(ms)`: `YYYY-MM-DD`.
pub(crate) fn utc_date(ms: i64) -> String {
    super::rows::iso_millis(ms)[..10].to_owned()
}

/// `cookielessVisitorId(salt, projectId, ip, userAgent)`.
pub(crate) fn cookieless_visitor_id(
    salt: &str,
    project_id: &str,
    ip: &str,
    user_agent: &str,
) -> String {
    let digest = Sha256::digest(format!("{salt}:{project_id}:{ip}:{user_agent}").as_bytes());
    format!("{COOKIELESS_PREFIX}{}", &hex::encode(digest)[..24])
}

fn new_salt() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    hex::encode(bytes)
}

/// Each UTC day's salt in the cache: `panel:salt:<date>`, claimed through
/// `panel:salt-claim:<date>`. This process keeps the day's salt once read,
/// as an isolate does.
pub struct CacheSalt {
    cache: Arc<dyn DynCache>,
    today: Mutex<Option<(String, String)>>,
}

impl CacheSalt {
    pub fn new(cache: Arc<dyn DynCache>) -> Self {
        Self {
            cache,
            today: Mutex::new(None),
        }
    }

    async fn lookup(&self, now_ms: i64) -> Result<String, PortError> {
        let date = utc_date(now_ms);
        if let Some((day, salt)) = self
            .today
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            && day == date
        {
            return Ok(salt);
        }
        let key = format!("panel:salt:{date}");
        let salt = match self.cache.get(&key).await? {
            Some(salt) if !salt.is_empty() => salt,
            _ => self.create(&date, &key, now_ms).await?,
        };
        *self.today.lock().unwrap_or_else(PoisonError::into_inner) = Some((date, salt.clone()));
        Ok(salt)
    }

    /// The first caller of the day writes the salt; the others wait for it.
    async fn create(&self, date: &str, key: &str, now_ms: i64) -> Result<String, PortError> {
        let claimed = self
            .cache
            .increment(
                &format!("panel:salt-claim:{date}"),
                1,
                Some(Duration::from_secs(10)),
            )
            .await?;
        if claimed == 1 {
            let salt = new_salt();
            // Deleted a minute past the next UTC midnight but one: yesterday's
            // salt stays for clocks a little behind.
            let expires = now_ms.div_euclid(DAY_MS) * DAY_MS + 2 * DAY_MS + 60_000;
            let ttl = u64::try_from((expires - now_ms) / 1000).unwrap_or(1).max(1);
            self.cache
                .put(key, &salt, Some(Duration::from_secs(ttl)))
                .await?;
            return Ok(salt);
        }
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(salt) = self.cache.get(key).await?.filter(|salt| !salt.is_empty()) {
                return Ok(salt);
            }
        }
        Err(PortError::backend(
            "the day's salt was claimed but not written",
        ))
    }
}

impl SaltSource for CacheSalt {
    fn today(&self, now_ms: i64) -> BoxFuture<'_, Result<String, PortError>> {
        Box::pin(self.lookup(now_ms))
    }
}

/// Events per workspace and UTC day: `panel:usage:<workspace>:<YYYY-MM-DD>`,
/// kept for 400 days.
pub struct CacheUsage {
    cache: Arc<dyn DynCache>,
}

impl CacheUsage {
    pub fn new(cache: Arc<dyn DynCache>) -> Self {
        Self { cache }
    }
}

impl UsageCounter for CacheUsage {
    fn add<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        events: u64,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let by = i64::try_from(events).map_err(PortError::backend)?;
            self.cache
                .increment(
                    &format!("panel:usage:{workspace_id}:{day}"),
                    by,
                    Some(Duration::from_hours(400 * 24)),
                )
                .await
                .map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cookieless_id_is_a_prefixed_hash() {
        let id = cookieless_visitor_id("salt", "pnp_1", "203.0.113.7", "UA");
        assert!(id.starts_with("ck_"));
        assert_eq!(id.len(), 27);
        assert_ne!(
            id,
            cookieless_visitor_id("other", "pnp_1", "203.0.113.7", "UA")
        );
    }

    #[tokio::test]
    async fn one_salt_per_day() {
        let cache: Arc<dyn DynCache> = Arc::new(weldsuite_ports::MemoryCache::default());
        let a = CacheSalt::new(Arc::clone(&cache));
        let b = CacheSalt::new(Arc::clone(&cache));
        let now = 1_793_102_398_000;
        let first = a.today(now).await.expect("a salt");
        assert_eq!(first.len(), 32);
        assert_eq!(b.today(now).await.expect("a salt"), first);
        assert_ne!(b.today(now + DAY_MS).await.expect("a salt"), first);
    }
}
