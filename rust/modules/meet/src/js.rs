//! JavaScript semantics the routes depend on (as in WeldSocial's `js.rs`),
//! and the few `@weldsuite/api-modules` helpers meet-api calls.

use http::HeaderMap;
use http::header::HOST;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_kit::validation::query_values;

/// `c.req.query(name)` (and `c.req.query()[name]`): the first value of a
/// query parameter.
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query_values(query).get(name).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    })
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : fallback, max)`: the
/// page size as JavaScript holds it, `NaN` included.
pub(crate) fn js_limit(raw: Option<&str>, fallback: f64, max: f64) -> f64 {
    match raw.filter(|raw| !raw.is_empty()) {
        None => fallback.min(max),
        // `Math.min(NaN, max)` is NaN.
        Some(raw) => js_parse_int(raw).map_or(f64::NAN, |value| value.min(max)),
    }
}

/// `.limit(n)`: Drizzle leaves the LIMIT out when it is `NaN` or negative
/// (`NULL` is no limit in Postgres).
pub(crate) fn sql_limit(n: f64) -> Option<i64> {
    if n.is_nan() || n < 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(n as i64)
}

/// `Number.parseInt(raw, 10)`: `None` for `NaN`.
pub(crate) fn js_parse_int(raw: &str) -> Option<f64> {
    let rest =
        raw.trim_start_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `rows.slice(0, end)` with JavaScript's negative `end`.
pub(crate) fn js_slice<T>(mut rows: Vec<T>, end: i64) -> Vec<T> {
    let len = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let end = if end < 0 {
        (len + end).max(0)
    } else {
        end.min(len)
    };
    rows.truncate(usize::try_from(end).unwrap_or(0));
    rows
}

/// A string field of a row; `None` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `a ?? b` for a JSON field: `None` when missing or null.
pub(crate) fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `Date.parse(text)` in milliseconds, for the ISO shapes JavaScript reads;
/// `None` where it is `NaN`.
pub(crate) fn parse_ms(text: &str) -> Option<i64> {
    let iso = weldsuite_kit::validation::js_date_iso(text)?;
    let parsed =
        OffsetDateTime::parse(&iso, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_of_ms(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// The request's origin as the client reached it (`new URL(c.req.url).origin`):
/// `X-Forwarded-Proto` and `X-Forwarded-Host` from the ingress, else the
/// `Host` header over HTTP.
pub(crate) fn request_origin(headers: &HeaderMap) -> String {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let host = header("x-forwarded-host")
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("localhost");
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    // `new URL(...).origin` drops a default port.
    let host = match (scheme, host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name,
        _ => host,
    };
    format!("{scheme}://{}", host.to_ascii_lowercase())
}

/// `(scheme, hostname, port)` of an origin.
fn split_origin(origin: &str) -> Option<(&str, &str, Option<&str>)> {
    let (scheme, rest) = origin.split_once("://")?;
    let rest = rest.split('/').next().unwrap_or(rest);
    if let Some(stripped) = rest.strip_prefix('[') {
        let (host, after) = stripped.split_once(']')?;
        return Some((scheme, host, after.strip_prefix(':')));
    }
    Some(match rest.rsplit_once(':') {
        Some((host, port)) => (scheme, host, Some(port)),
        None => (scheme, rest, None),
    })
}

/// `originForPathFrom(requestOrigin, path)` of `@weldsuite/api-modules`: the
/// origin of the worker that owns `path`, seen from a request that reached
/// any API worker. On localhost, that worker's dev port; on
/// `<worker>(-env).<domain>`, its own host; anywhere else (one origin for
/// every module, as on Kubernetes) the request's origin.
pub(crate) fn origin_for_path_from(request_origin: &str, path: &str) -> String {
    let Some((scheme, host, _)) = split_origin(request_origin) else {
        return request_origin.to_owned();
    };
    let module = weldsuite_catalogs::find_module_for_path(path);
    if host == "localhost" || host == "127.0.0.1" {
        if module.id == "core" {
            let core = weldsuite_catalogs::api_module("core").map_or(8789, |m| m.dev_port);
            return format!("{scheme}://{host}:{core}");
        }
        return format!("{scheme}://{host}:{}", module.dev_port);
    }
    let workers: Vec<&str> = weldsuite_catalogs::api_modules()
        .iter()
        .map(|m| m.worker.as_str())
        .collect();
    // `coreOriginFrom`: a worker host maps onto app-api's.
    let Some((env, domain)) = workers.iter().find_map(|worker| {
        let rest = host.strip_prefix(worker)?;
        let (env, domain) = match rest.strip_prefix('-') {
            Some(after) => {
                let (env, domain) = after.split_once('.')?;
                let valid = !env.is_empty()
                    && env
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
                if !valid {
                    return None;
                }
                (format!("-{env}"), domain)
            }
            None => (String::new(), rest.strip_prefix('.')?),
        };
        (!domain.is_empty()).then_some((env, domain))
    }) else {
        return request_origin.to_owned();
    };
    let port = split_origin(request_origin)
        .and_then(|(_, _, port)| port)
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    format!("{scheme}://{}{env}.{domain}{port}", module.worker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_read_like_the_routes() {
        assert_eq!(js_limit(None, 25.0, 100.0), 25.0);
        assert_eq!(js_limit(Some("10"), 25.0, 100.0), 10.0);
        assert_eq!(js_limit(Some("500"), 25.0, 100.0), 100.0);
        assert!(js_limit(Some("abc"), 25.0, 100.0).is_nan());
        assert_eq!(sql_limit(f64::NAN), None);
        assert_eq!(sql_limit(26.0), Some(26));
        assert_eq!(js_slice(vec![1, 2, 3], -1), vec![1, 2]);
    }

    #[test]
    fn origins_follow_the_owning_worker() {
        let path = "/public/meeting-recordings";
        assert_eq!(
            origin_for_path_from("http://localhost", path),
            "http://localhost:8810"
        );
        assert_eq!(
            origin_for_path_from("https://app-api-test.weldsuite.org", path),
            "https://meet-api-test.weldsuite.org"
        );
        assert_eq!(
            origin_for_path_from("https://meet-api.weldsuite.org", path),
            "https://meet-api.weldsuite.org"
        );
        assert_eq!(
            origin_for_path_from("https://weldsuite.example.eu", path),
            "https://weldsuite.example.eu"
        );
        assert_eq!(
            origin_for_path_from(
                "https://app-api.weldsuite.org",
                "/api/webhooks/cloudflare-realtime"
            ),
            "https://meet-api.weldsuite.org"
        );
    }
}
