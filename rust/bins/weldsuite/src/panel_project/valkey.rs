//! What the project state keeps in Valkey, per project (keys under the
//! cache prefix, hash-tagged by the project so a script's keys share a
//! slot):
//!
//! - **The live view** (the object's `live` table): `panel:{<project>}:live`,
//!   a sorted set of session ids scored by their last time (ms), and
//!   `panel:{<project>}:live-sessions`, each session's row as JSON. A touch
//!   counts a new path as a page view, keeps the later time, drops what left
//!   the five-minute window and keeps the newest 2000 sessions, in one
//!   script; touches of erased ids are refused while the erased set is
//!   known.
//! - **The erased ids** the collector checks (`panel:{<project>}:erased`):
//!   a set holding a NUL member while it is known, so a missing key means
//!   "unknown", never "none erased".
//! - **The group types** the collector filters by
//!   (`panel:{<project>}:group-types`): a JSON array in slot order. A
//!   collector takes a free slot here at once (the object's rule, in one
//!   script), and the applier takes the same slot in the tenant tables in
//!   stream order and writes the list back whenever it changes.
//!
//! The tenant tables are the source of truth for the last two: the applier
//! and the panel routes rewrite them from there, and a missing key is
//! filled by the applier, never by the collector.

// The collector's side is not built in conformance builds (the test's
// `PANEL_PROJECT` stands in).
#![cfg_attr(feature = "conformance", allow(dead_code))]

use std::time::Duration;

use redis::aio::ConnectionManager;
use weldsuite_panel::project_state::{LiveSession, LiveTouch};
use weldsuite_ports::PortError;

use super::rules::{LIVE_WINDOW_MS, MAX_GROUP_TYPES, MAX_LIVE_SESSIONS};

/// How long the erased ids and the group types stay without a write.
const STATE_TTL: Duration = Duration::from_hours(30 * 24);
/// The live keys outlive the window a little, then go with an idle project.
const LIVE_TTL_MS: i64 = LIVE_WINDOW_MS + 60_000;
/// How long a collector waits before asking for a warm-up again.
const WARMING_TTL_MS: u64 = 30_000;
/// The erased set's marker: known (NUL is no id Postgres can hold).
const KNOWN: &str = "\u{0}";

/// `KEYS`: live, live-sessions, erased. `ARGV`: max sessions, ttl (ms),
/// window start (ms), then a touch's JSON and score (ms) per touch.
const TOUCH: &str = r"
local live, sessions, erased = KEYS[1], KEYS[2], KEYS[3]
local max, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
local known = redis.call('EXISTS', erased) == 1
for i = 4, #ARGV, 2 do
  local touch = cjson.decode(ARGV[i])
  local score = tonumber(ARGV[i + 1])
  local refused = known and (redis.call('SISMEMBER', erased, touch.distinctId) == 1
    or redis.call('SISMEMBER', erased, touch.sessionId) == 1)
  if not refused then
    local held = redis.call('HGET', sessions, touch.sessionId)
    local row
    if held then
      row = cjson.decode(held)
      if touch.path ~= row.path then row.pageviews = row.pageviews + 1 end
      row.distinctId = touch.distinctId
      row.path = touch.path
      row.title = touch.title
      row.country = touch.country
      row.deviceType = touch.deviceType
      if touch.ts > row.ts then
        row.ts = touch.ts
      else
        score = tonumber(redis.call('ZSCORE', live, touch.sessionId)) or score
      end
    else
      row = { sessionId = touch.sessionId, distinctId = touch.distinctId, path = touch.path,
        title = touch.title, country = touch.country, deviceType = touch.deviceType,
        ts = touch.ts, startedAt = touch.ts, pageviews = 1 }
    end
    redis.call('HSET', sessions, touch.sessionId, cjson.encode(row))
    redis.call('ZADD', live, score, touch.sessionId)
  end
end
local function drop(ids)
  for i = 1, #ids, 500 do
    local last = math.min(i + 499, #ids)
    redis.call('HDEL', sessions, unpack(ids, i, last))
    redis.call('ZREM', live, unpack(ids, i, last))
  end
end
drop(redis.call('ZRANGEBYSCORE', live, '-inf', '(' .. ARGV[3]))
local count = redis.call('ZCARD', live)
if count > max then drop(redis.call('ZRANGE', live, 0, count - max - 1)) end
redis.call('PEXPIRE', live, ttl)
redis.call('PEXPIRE', sessions, ttl)
if known then return 1 else return 0 end
";

/// `KEYS`: live, live-sessions. `ARGV`: window start (ms). The sessions in
/// the window, latest first.
const READ: &str = r"
local ids = redis.call('ZREVRANGEBYSCORE', KEYS[1], '+inf', ARGV[1])
if #ids == 0 then return {} end
return redis.call('HMGET', KEYS[2], unpack(ids))
";

/// `KEYS`: live, live-sessions. `ARGV`: ids. Drops the sessions whose
/// session id or distinct id is one of them.
const FORGET: &str = r"
local doomed = {}
for i = 1, #ARGV do doomed[ARGV[i]] = true end
local all = redis.call('HGETALL', KEYS[2])
local removed = 0
for i = 1, #all, 2 do
  local row = cjson.decode(all[i + 1])
  if doomed[all[i]] or doomed[row.distinctId] then
    redis.call('HDEL', KEYS[2], all[i])
    redis.call('ZREM', KEYS[1], all[i])
    removed = removed + 1
  end
end
return removed
";

/// `KEYS`: erased. `ARGV`: ttl (ms), the marker, then the ids.
const SET_ERASED: &str = r"
redis.call('DEL', KEYS[1])
for i = 2, #ARGV, 500 do
  redis.call('SADD', KEYS[1], unpack(ARGV, i, math.min(i + 499, #ARGV)))
end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
";

/// `KEYS`: group-types. `ARGV`: max types, then the types wanted. False
/// when the list is unknown; else `[changed, ...types]`.
const TAKE: &str = r"
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local types = cjson.decode(raw)
local max = tonumber(ARGV[1])
local changed = 0
for i = 2, #ARGV do
  local have = false
  for _, known in ipairs(types) do
    if known == ARGV[i] then have = true break end
  end
  if not have and #types < max then
    types[#types + 1] = ARGV[i]
    changed = 1
  end
end
if changed == 1 then redis.call('SET', KEYS[1], cjson.encode(types), 'KEEPTTL') end
local out = { tostring(changed) }
for _, known in ipairs(types) do out[#out + 1] = known end
return out
";

/// One process's handle on the project state in Valkey.
#[derive(Clone)]
pub(crate) struct PanelValkey {
    connection: ConnectionManager,
    prefix: String,
}

impl std::fmt::Debug for PanelValkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PanelValkey")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl PanelValkey {
    /// Keys under `prefix` (`VALKEY_CACHE_PREFIX`).
    pub(crate) fn new(connection: ConnectionManager, prefix: impl Into<String>) -> Self {
        Self {
            connection,
            prefix: prefix.into(),
        }
    }

    fn key(&self, project_id: &str, name: &str) -> String {
        format!("{}panel:{{{project_id}}}:{name}", self.prefix)
    }

    async fn eval<T: redis::FromRedisValue>(
        &self,
        script: &str,
        keys: &[String],
        args: Vec<String>,
    ) -> Result<T, PortError> {
        let mut command = redis::cmd("EVAL");
        command.arg(script).arg(keys.len());
        for key in keys {
            command.arg(key);
        }
        for arg in args {
            command.arg(arg);
        }
        let mut connection = self.connection.clone();
        command
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)
    }

    // --- the live view -------------------------------------------------

    /// `touchLive`: the touches, at `now_ms`. True when the erased ids were
    /// known (touches of erased ids were refused).
    pub(crate) async fn touch(
        &self,
        project_id: &str,
        touches: &[LiveTouch],
        now_ms: i64,
    ) -> Result<bool, PortError> {
        if touches.is_empty() {
            return Ok(true);
        }
        let mut args = vec![
            MAX_LIVE_SESSIONS.to_string(),
            LIVE_TTL_MS.to_string(),
            (now_ms - LIVE_WINDOW_MS).to_string(),
        ];
        for touch in touches {
            args.push(serde_json::to_string(touch)?);
            let score = super::rules::iso_millis(&touch.ts).unwrap_or(now_ms);
            args.push(score.to_string());
        }
        let keys = [
            self.key(project_id, "live"),
            self.key(project_id, "live-sessions"),
            self.key(project_id, "erased"),
        ];
        self.eval::<i64>(TOUCH, &keys, args)
            .await
            .map(|known| known == 1)
    }

    /// The sessions seen since `now_ms` minus the window, latest first.
    pub(crate) async fn sessions(
        &self,
        project_id: &str,
        now_ms: i64,
    ) -> Result<Vec<LiveSession>, PortError> {
        let keys = [
            self.key(project_id, "live"),
            self.key(project_id, "live-sessions"),
        ];
        let rows: Vec<Option<String>> = self
            .eval(READ, &keys, vec![(now_ms - LIVE_WINDOW_MS).to_string()])
            .await?;
        Ok(rows
            .into_iter()
            .flatten()
            .filter_map(|row| serde_json::from_str(&row).ok())
            .collect())
    }

    /// Drops the sessions an erasure names (by session or distinct id).
    pub(crate) async fn forget(&self, project_id: &str, ids: &[String]) -> Result<(), PortError> {
        if ids.is_empty() {
            return Ok(());
        }
        let keys = [
            self.key(project_id, "live"),
            self.key(project_id, "live-sessions"),
        ];
        self.eval::<i64>(FORGET, &keys, ids.to_vec())
            .await
            .map(|_| ())
    }

    // --- the erased ids --------------------------------------------------

    /// Replaces the project's erased ids (now known).
    pub(crate) async fn set_erased(
        &self,
        project_id: &str,
        ids: &[String],
    ) -> Result<(), PortError> {
        let mut args = vec![millis(STATE_TTL).to_string(), KNOWN.to_owned()];
        args.extend(ids.iter().cloned());
        self.eval::<i64>(SET_ERASED, &[self.key(project_id, "erased")], args)
            .await
            .map(|_| ())
    }

    // --- the group types -------------------------------------------------

    /// Replaces the project's group types.
    pub(crate) async fn set_group_types(
        &self,
        project_id: &str,
        types: &[String],
    ) -> Result<(), PortError> {
        let mut connection = self.connection.clone();
        redis::cmd("SET")
            .arg(self.key(project_id, "group-types"))
            .arg(serde_json::to_string(types)?)
            .arg("PX")
            .arg(millis(STATE_TTL))
            .query_async::<()>(&mut connection)
            .await
            .map_err(PortError::backend)
    }

    /// The project's group types, or none while unknown.
    pub(crate) async fn group_types(
        &self,
        project_id: &str,
    ) -> Result<Option<Vec<String>>, PortError> {
        let mut connection = self.connection.clone();
        let raw: Option<String> = redis::cmd("GET")
            .arg(self.key(project_id, "group-types"))
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(PortError::Json))
            .transpose()
    }

    /// `takeGroupTypes` on the cached list: each (valid) type gets a free
    /// slot. None while the list is unknown; else the types after and
    /// whether any was taken.
    pub(crate) async fn take_group_types(
        &self,
        project_id: &str,
        types: &[String],
    ) -> Result<Option<(Vec<String>, bool)>, PortError> {
        let mut args = vec![MAX_GROUP_TYPES.to_string()];
        args.extend(types.iter().cloned());
        let out: Option<Vec<String>> = self
            .eval(TAKE, &[self.key(project_id, "group-types")], args)
            .await?;
        Ok(out.map(|mut out| {
            let changed = !out.is_empty() && out.remove(0) == "1";
            (out, changed)
        }))
    }

    // --- warming ---------------------------------------------------------

    /// Which of the two lists are unknown: (erased ids, group types).
    pub(crate) async fn missing(&self, project_id: &str) -> Result<(bool, bool), PortError> {
        let mut connection = self.connection.clone();
        let (erased, types): (i64, i64) = redis::pipe()
            .cmd("EXISTS")
            .arg(self.key(project_id, "erased"))
            .cmd("EXISTS")
            .arg(self.key(project_id, "group-types"))
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok((erased == 0, types == 0))
    }

    /// Whether this caller is the one to ask for a warm-up now (at most one
    /// ask per project every half minute).
    pub(crate) async fn claim_warming(&self, project_id: &str) -> Result<bool, PortError> {
        let mut connection = self.connection.clone();
        let set: Option<String> = redis::cmd("SET")
            .arg(self.key(project_id, "warming"))
            .arg("1")
            .arg("NX")
            .arg("PX")
            .arg(WARMING_TTL_MS)
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(set.is_some())
    }
}
