//! `routes/recordings.ts`: `POST /r` (one recording chunk) and `POST /snap`
//! (one masked page snapshot for a heatmap background), gzip bodies from the
//! browser SDK, stored in the panel bucket under the key layout Global uses
//! in its replays bucket (ADR PANEL-005). Same shape as `POST /e`: what can
//! be decided from the request is decided before the answer, malformed gets
//! an error, and anything we choose not to keep (paused project, wrong
//! origin, bot, filtered IP, quota, recordings off) is a 204, so the SDK
//! never retries. The storing runs in the background, after the 204.
//!
//! Without the bucket the feature is off: one warning, 204.
//!
//! A chunk's row goes to `replay_chunks_v1` through the chunk index
//! ([`RequestCollector::chunks`]: subject `panel.replays.v1.<workspace>` of
//! the `PANEL_STATE` stream, which `panel-writer` reads), and a session's
//! first chunk counts one recording for the workspace's day.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode, Uri};
use serde_json::{Value, json};
use weldsuite_kit::validation::js_number;
use weldsuite_ports::{Cache, DynCache, DynFileStore, PortError, PutOptions};

use super::ip_filter::matches_ip_filter;
use super::limits::{Limit, rate_limited};
use super::rows::iso_millis;
use super::user_agent::is_bot_user_agent;
use super::visitor::utc_date;
use super::{
    CollectorState, Ctx, RequestCollector, load_project, log_failure, quota_state,
    read_bytes_limited, reject, too_many, warn_once, went_wrong,
};
use crate::domain::{
    ProjectRecord, heatmap_snapshot_key, is_allowed_origin, is_device_class, is_page_group_id,
    js_string, parse_snapshot_request, replay_chunk_key, snapshot_request_key,
};

/// A chunk or snapshot is at most this many compressed bytes.
pub(crate) const MAX_BLOB_BYTES: usize = 1024 * 1024;
const MAX_SEQ: u64 = 100_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `c.req.query()`: each name's first value, `+` and percent-escapes
/// decoded; a name left empty is skipped.
fn query(uri: &Uri) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for (name, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        if !name.is_empty() {
            values
                .entry(name.into_owned())
                .or_insert_with(|| value.into_owned());
        }
    }
    values
}

/// A non-negative whole number from a query value (`/^\d{1,16}$/`, a safe
/// integer); `None` for anything else (`1e3`, ` 5`, `-1`).
fn whole_number(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if !(1..=16).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
}

/// `SESSION_ID`: `/^[\w-]{1,64}$/`.
fn is_session_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Gzip streams start with 1f 8b: a cheap check that the body is what the
/// route says, without inflating it.
fn looks_gzipped(bytes: &[u8]) -> bool {
    bytes.len() >= 18 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// `project.settings.recordingSampleRate <= 0`, as JavaScript compares it.
fn recordings_off(settings: &Value) -> bool {
    match settings.get("recordingSampleRate") {
        None | Some(Value::Object(_)) => false,
        Some(Value::Null) => true,
        Some(Value::Bool(on)) => !on,
        Some(Value::Number(rate)) => rate.as_f64().is_some_and(|rate| rate <= 0.0),
        Some(value @ (Value::String(_) | Value::Array(_))) => js_number(&js_string(value)) <= 0.0,
    }
}

fn bad_request(message: &str) -> Response {
    reject(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

fn gzip() -> PutOptions {
    PutOptions::content_type("application/gzip")
}

/// A body to store, its project and the bucket.
struct Accepted {
    project: ProjectRecord,
    bytes: Vec<u8>,
    replays: Arc<dyn DynFileStore>,
}

/// What both routes share, after their own query checks (the rate limit
/// has been applied): reads the body, finds the project and applies the
/// drops. `Err` is the answer.
async fn accept(
    state: &CollectorState,
    ctx: &Ctx,
    ports: &RequestCollector,
    request: (&HeaderMap, Body),
    token: &str,
    ip: &str,
    what: &str,
) -> Result<Accepted, Box<Response>> {
    let (headers, body) = request;
    let Some(bytes) = read_bytes_limited(headers, body, MAX_BLOB_BYTES).await else {
        return Err(Box::new(reject(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            &format!("A body is at most {MAX_BLOB_BYTES} bytes"),
        )));
    };
    if !looks_gzipped(&bytes) {
        return Err(Box::new(reject(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "The body is not gzip",
        )));
    }
    let project = match load_project(ctx, state, token).await {
        Ok(Some(project)) => project,
        Ok(None) => {
            return Err(Box::new(reject(
                StatusCode::NOT_FOUND,
                "unknown_project",
                "Unknown project token",
            )));
        }
        Err(error) => return Err(Box::new(went_wrong(&error, what))),
    };

    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let dropped = !is_allowed_origin(header("origin"), &project.allowed_domains)
        || project.status == "paused"
        || is_bot_user_agent(header("user-agent").unwrap_or_default())
        || matches_ip_filter(ip, &project.setting_strings("ipFilters"))
        || recordings_off(&project.settings)
        || quota_state(ctx, state, &project.workspace_id).await != "ok";
    if dropped {
        return Err(Box::new(no_content()));
    }
    let Some(replays) = ports.replays.clone() else {
        warn_once(
            "binding:PANEL_REPLAYS",
            "PANEL_REPLAYS is not bound: recordings and heatmap snapshots are off",
        );
        return Err(Box::new(no_content()));
    };
    Ok(Accepted {
        project,
        bytes,
        replays,
    })
}

/// One chunk's place in its session (`ChunkParams`).
struct Chunk {
    session_id: String,
    seq: u64,
    /// Chunk start and end, ms since the epoch, already inside a believable window.
    ts_start: i64,
    ts_end: i64,
    has_full_snapshot: bool,
    received_at: i64,
}

/// `POST /r`.
pub(super) async fn chunk(
    State(state): State<CollectorState>,
    ctx: Ctx,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let ports = ctx.ports(&state);
    let ip = ctx.addresses(&state, &headers).client;
    if rate_limited(ports.limits.as_ref(), Limit::Replays, &ip).await {
        return too_many();
    }

    let query = query(&uri);
    let get = |name: &str| query.get(name).map(String::as_str);
    let token = get("t").unwrap_or_default();
    let session_id = get("s").unwrap_or_default();
    let seq = whole_number(get("q"));
    let start = whole_number(get("a"));
    let end = whole_number(get("b"));
    let full = get("f");
    if token.is_empty() {
        return bad_request("t: the project token is required");
    }
    if !is_session_id(session_id) {
        return bad_request("s: not a session id");
    }
    let Some(seq) = seq.filter(|seq| *seq <= MAX_SEQ) else {
        return bad_request(&format!("q: a whole number from 0 to {MAX_SEQ}"));
    };
    let (Some(start), Some(end)) = (start, end) else {
        return bad_request("a, b: millisecond times, b not before a");
    };
    if end < start {
        return bad_request("a, b: millisecond times, b not before a");
    }
    if full != Some("0") && full != Some("1") {
        return bad_request("f: 0 or 1");
    }

    let accepted = match accept(
        &state,
        &ctx,
        &ports,
        (&headers, body),
        token,
        &ip,
        "POST /r",
    )
    .await
    {
        Ok(accepted) => accepted,
        Err(answer) => return *answer,
    };

    let received_at = ctx.now_ms();
    // The client clock decides these only as far as a session's times can:
    // kept inside a believable window.
    let clamp = |ms: u64| {
        i64::try_from(ms)
            .unwrap_or(i64::MAX)
            .clamp(received_at - 7 * DAY_MS, received_at + 60 * 1000)
    };
    let chunk = Chunk {
        session_id: session_id.to_owned(),
        seq,
        ts_start: clamp(start),
        ts_end: clamp(end),
        has_full_snapshot: full == Some("1"),
        received_at,
    };
    state
        .events
        .tracker()
        .spawn(store_chunk(ports, accepted, chunk));
    no_content()
}

/// `storeChunk`: the chunk to the bucket, its row to the chunk index and
/// (for a session's first chunk) the recording to the day's count. Failures
/// are logged with ids only.
async fn store_chunk(ports: RequestCollector, accepted: Accepted, chunk: Chunk) {
    let Accepted {
        project,
        bytes,
        replays,
    } = accepted;
    // The chunk's own start day: a session that runs past midnight keeps its
    // later chunks under the new day, and `r2_key` is what finds them.
    let key = replay_chunk_key(
        &project.replay_tier(),
        &project.workspace_id,
        &project.project_id,
        &utc_date(chunk.ts_start),
        &chunk.session_id,
        chunk.seq,
    );
    let size = bytes.len();
    if let Err(error) = replays.put_boxed(&key, bytes, &gzip()).await {
        log_failure("Recording chunk write", &project, &error);
        return;
    }
    let row = json!({
        "workspace_id": project.workspace_id,
        "project_id": project.project_id,
        "session_id": chunk.session_id,
        "seq": chunk.seq,
        "ts_start": iso_millis(chunk.ts_start),
        "ts_end": iso_millis(chunk.ts_end),
        "bytes": size,
        "has_full_snapshot": chunk.has_full_snapshot,
        "r2_key": key,
    });
    let index = async {
        if let Some(chunks) = &ports.chunks {
            chunks.send(std::slice::from_ref(&row)).await
        } else {
            warn_once(
                "binding:PANEL_REPLAY_CHUNKS",
                "PANEL_REPLAY_CHUNKS is not bound: recording chunks are stored but not indexed",
            );
            Ok(())
        }
    };
    // A recording is counted when its first chunk arrives.
    let count = async {
        if chunk.seq != 0 {
            return Ok(());
        }
        match &ports.usage {
            Some(usage) => {
                usage
                    .add_recordings(&project.workspace_id, &utc_date(chunk.received_at), 1)
                    .await
            }
            None => Err(PortError::backend("no usage counter")),
        }
    };
    let (index, count) = futures_util::join!(index, count);
    for result in [index, count] {
        if let Err(error) = result {
            log_failure("Recording index or count", &project, &error);
        }
    }
}

/// `POST /snap`.
pub(super) async fn snapshot(
    State(state): State<CollectorState>,
    ctx: Ctx,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let ports = ctx.ports(&state);
    let ip = ctx.addresses(&state, &headers).client;
    if rate_limited(ports.limits.as_ref(), Limit::Snapshots, &ip).await {
        return too_many();
    }

    let query = query(&uri);
    let get = |name: &str| query.get(name).map(String::as_str);
    let token = get("t").unwrap_or_default();
    let page_group_id = get("g").unwrap_or_default();
    let device_class = get("d").unwrap_or_default();
    if token.is_empty() {
        return bad_request("t: the project token is required");
    }
    if !is_page_group_id(page_group_id) {
        return bad_request("g: not a page group id");
    }
    if !is_device_class(device_class) {
        return bad_request("d: desktop, tablet or mobile");
    }

    let accepted = match accept(
        &state,
        &ctx,
        &ports,
        (&headers, body),
        token,
        &ip,
        "POST /snap",
    )
    .await
    {
        Ok(accepted) => accepted,
        Err(answer) => return *answer,
    };
    let cache = ctx.cache(&state);
    let page_group_id = page_group_id.to_owned();
    let device_class = device_class.to_owned();
    state.events.tracker().spawn(async move {
        let project = accepted.project.clone();
        if let Err(error) = store_snapshot(cache, accepted, &page_group_id, &device_class).await {
            log_failure("Snapshot write", &project, &error);
        }
    });
    no_content()
}

/// `acceptSnapshot`: stores the snapshot only if the project asked for
/// exactly this page group and device class (the project token is public,
/// so without the request anyone could overwrite a heatmap background).
/// Once stored the request is deleted, if it still is the one answered, so
/// visitors stop being asked.
async fn store_snapshot(
    cache: Option<Arc<dyn DynCache>>,
    accepted: Accepted,
    page_group_id: &str,
    device_class: &str,
) -> Result<(), PortError> {
    let Accepted {
        project,
        bytes,
        replays,
    } = accepted;
    let Some(cache) = cache else {
        return Ok(());
    };
    let key = snapshot_request_key(&project.project_id);
    let raw = cache.get(&key).await?;
    let Some(request) = parse_snapshot_request(raw.as_deref()) else {
        return Ok(());
    };
    if request["pageGroupId"] != page_group_id || request["deviceClass"] != device_class {
        return Ok(());
    }
    let target = heatmap_snapshot_key(
        &project.workspace_id,
        &project.project_id,
        page_group_id,
        device_class,
    );
    replays.put_boxed(&target, bytes, &gzip()).await?;
    if cache.get(&key).await? == raw {
        cache.delete(&key).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_query_as_hono_does() {
        let uri: Uri = "/r?t=wpk_1&s=a+b&s=second&q=%31&=x&f"
            .parse()
            .expect("a uri");
        let values = query(&uri);
        assert_eq!(values["t"], "wpk_1");
        assert_eq!(values["s"], "a b");
        assert_eq!(values["q"], "1");
        assert_eq!(values["f"], "");
        assert!(!values.contains_key(""));
    }

    #[test]
    fn whole_numbers_are_digits_only() {
        assert_eq!(whole_number(Some("0")), Some(0));
        assert_eq!(whole_number(Some("100000")), Some(100_000));
        assert_eq!(
            whole_number(Some("9007199254740991")),
            Some(9_007_199_254_740_991)
        );
        for bad in [
            "",
            "-1",
            "1.5",
            "1e3",
            " 5",
            "9007199254740992",
            "12345678901234567",
        ] {
            assert_eq!(whole_number(Some(bad)), None, "{bad}");
        }
        assert_eq!(whole_number(None), None);
    }

    #[test]
    fn session_ids_and_gzip() {
        assert!(is_session_id("s-0123456789"));
        assert!(!is_session_id("no spaces allowed"));
        assert!(!is_session_id(&"a".repeat(65)));
        let mut gzip = vec![0u8; 18];
        gzip[0] = 0x1f;
        gzip[1] = 0x8b;
        assert!(looks_gzipped(&gzip));
        assert!(!looks_gzipped(&gzip[..17]));
        assert!(!looks_gzipped(
            b"[{\"type\":2}]                                "
        ));
    }

    #[test]
    fn recordings_are_off_at_a_rate_of_zero_as_javascript_compares() {
        let off = |rate: Value| recordings_off(&json!({ "recordingSampleRate": rate }));
        assert!(off(json!(0)));
        assert!(off(json!(-1)));
        assert!(off(Value::Null));
        assert!(off(json!(false)));
        assert!(off(json!("0")));
        assert!(off(json!([])));
        assert!(!off(json!(0.25)));
        assert!(!off(json!("abc")));
        assert!(!off(json!({})));
        assert!(!recordings_off(&json!({})));
    }
}
