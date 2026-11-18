//! A lease in Valkey: one holder at a time for a named piece of work across
//! the pods of a role (WeldPanel's `panel-writer` holds one per table, so one
//! replica writes a table while the others stand by).
//!
//! The key holds the holder's random token with a time to live: taken with
//! `SET NX PX`, kept with a renewal that only extends the holder's own token,
//! given back with a delete that only removes it. A holder that stops
//! renewing (a crash, a partition, a long pause) loses the lease when the
//! time runs out, so the work must also be fenced where it commits (the
//! writer's commit is, on the table's stream sequence).

use std::fmt;
use std::time::Duration;

use redis::aio::ConnectionManager;
use weldsuite_ports::PortError;

/// Extends the key's time to live if it still holds `ARGV[1]`.
const RENEW: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then \
     return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

/// Deletes the key if it still holds `ARGV[1]`.
const RELEASE: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then \
     return redis.call('DEL', KEYS[1]) else return 0 end";

/// One lease, as one would-be holder sees it.
#[derive(Clone)]
pub struct ValkeyLease {
    connection: ConnectionManager,
    key: String,
    token: String,
    ttl: Duration,
}

impl fmt::Debug for ValkeyLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ValkeyLease")
            .field("key", &self.key)
            .field("token", &self.token)
            .field("ttl", &self.ttl)
            .finish_non_exhaustive()
    }
}

impl ValkeyLease {
    /// The lease on `key`, for a holder named `holder` (the pod; a random
    /// suffix makes each process its own holder), lasting `ttl` past each
    /// take or renewal.
    pub fn new(
        connection: ConnectionManager,
        key: impl Into<String>,
        holder: &str,
        ttl: Duration,
    ) -> Self {
        let suffix: [u8; 8] = rand_bytes();
        Self {
            connection,
            key: key.into(),
            token: format!("{holder}:{}", hex::encode(suffix)),
            ttl,
        }
    }

    /// The key.
    pub fn key(&self) -> &str {
        &self.key
    }

    fn millis(&self) -> u64 {
        u64::try_from(self.ttl.as_millis())
            .unwrap_or(u64::MAX)
            .max(1)
    }

    /// Takes the lease if nobody holds it (or this holder already does).
    pub async fn try_acquire(&self) -> Result<bool, PortError> {
        let mut connection = self.connection.clone();
        let taken: Option<String> = redis::cmd("SET")
            .arg(&self.key)
            .arg(&self.token)
            .arg("NX")
            .arg("PX")
            .arg(self.millis())
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        if taken.is_some() {
            return Ok(true);
        }
        self.renew().await
    }

    /// Extends the lease; false when this holder no longer has it.
    pub async fn renew(&self) -> Result<bool, PortError> {
        let mut connection = self.connection.clone();
        let renewed: i64 = redis::cmd("EVAL")
            .arg(RENEW)
            .arg(1)
            .arg(&self.key)
            .arg(&self.token)
            .arg(self.millis())
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(renewed == 1)
    }

    /// Gives the lease back, if this holder still has it.
    pub async fn release(&self) -> Result<(), PortError> {
        let mut connection = self.connection.clone();
        let _: i64 = redis::cmd("EVAL")
            .arg(RELEASE)
            .arg(1)
            .arg(&self.key)
            .arg(&self.token)
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(())
    }
}

fn rand_bytes() -> [u8; 8] {
    let mut bytes = [0_u8; 8];
    // The OS's generator; a failure leaves zeros, still told apart by `holder`.
    let _ = aws_lc_rs::rand::fill(&mut bytes);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against a throwaway Valkey (`WELDSUITE_TEST_VALKEY_URL`); skipped without.
    #[tokio::test]
    async fn one_holder_at_a_time_until_it_lets_go_or_runs_out() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_VALKEY_URL") else {
            eprintln!("skipped: WELDSUITE_TEST_VALKEY_URL is not set");
            return;
        };
        let connection = crate::connect_valkey(&url).await.expect("valkey");
        let key = format!("test:lease:{}", hex::encode(rand_bytes()));
        let a = ValkeyLease::new(
            connection.clone(),
            &key,
            "pod-a",
            Duration::from_millis(400),
        );
        let b = ValkeyLease::new(connection, &key, "pod-b", Duration::from_millis(400));
        assert!(a.try_acquire().await.expect("a takes it"));
        assert!(a.try_acquire().await.expect("a still has it"));
        assert!(!b.try_acquire().await.expect("b waits"));
        assert!(!b.renew().await.expect("b has nothing to renew"));
        assert!(a.renew().await.expect("a renews"));
        b.release().await.expect("b can't give back a's lease");
        assert!(!b.try_acquire().await.expect("still a's"));
        a.release().await.expect("a lets go");
        assert!(b.try_acquire().await.expect("b takes it"));
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!b.renew().await.expect("ran out"));
        assert!(a.try_acquire().await.expect("a takes it again"));
        a.release().await.expect("cleanup");
    }
}
