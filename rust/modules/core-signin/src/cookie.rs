//! The provider session, in a cookie only this module reads.
//!
//! `HttpOnly`, so no script on the page can read it; `SameSite=Strict` and
//! scoped to `/api/sign-in`, so it travels with the sign-in screens' own calls
//! and nothing else. Its value is the session's id and current token, which
//! the provider checks on every use: a made-up cookie names no session.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::header::{COOKIE, HOST};
use http::{HeaderMap, HeaderValue};
use weldsuite_ports::SessionRef;

pub(crate) const NAME: &str = "weldsuite_signin";
const ATTRIBUTES: &str = "Path=/api/sign-in; HttpOnly; SameSite=Strict";

/// What a response does to the cookie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Change {
    Keep,
    /// The session, kept for as long as the provider keeps it.
    Set(SessionRef, Duration),
    Clear,
}

/// `Secure` everywhere except a server reached as `localhost` (development
/// over plain HTTP, where a browser would drop a `Secure` cookie).
pub(crate) fn secure(headers: &HeaderMap) -> bool {
    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let name = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    !matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

/// The session the request's cookie names.
pub(crate) fn read(headers: &HeaderMap) -> Option<SessionRef> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == NAME)
        .and_then(|(_, value)| decode(value))
}

fn decode(value: &str) -> Option<SessionRef> {
    let (id, token) = value.split_once('.')?;
    let text = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|text| !text.is_empty())
    };
    Some(SessionRef {
        id: text(id)?,
        token: text(token)?,
    })
}

/// The `Set-Cookie` for a change; `None` leaves the cookie as it is.
pub(crate) fn header(change: &Change, secure: bool) -> Option<HeaderValue> {
    let (value, max_age) = match change {
        Change::Keep => return None,
        Change::Set(session, lifetime) => (
            format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(&session.id),
                URL_SAFE_NO_PAD.encode(&session.token)
            ),
            lifetime.as_secs(),
        ),
        Change::Clear => (String::new(), 0),
    };
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{NAME}={value}; Max-Age={max_age}; {ATTRIBUTES}{secure}"
    ))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).expect("value"));
        }
        headers
    }

    #[test]
    fn a_session_round_trips_through_the_cookie() {
        let session = SessionRef {
            id: "300000000000000100".to_owned(),
            token: "tok/en+with=odd;chars".to_owned(),
        };
        let set = header(
            &Change::Set(session.clone(), Duration::from_secs(3600)),
            true,
        )
        .expect("header");
        let text = set.to_str().expect("text");
        assert!(
            text.ends_with("; Max-Age=3600; Path=/api/sign-in; HttpOnly; SameSite=Strict; Secure")
        );
        let value = text.split(';').next().expect("pair");
        let request = headers(&[("cookie", &format!("theme=dark; {value}"))]);
        assert_eq!(read(&request), Some(session));
    }

    #[test]
    fn a_cookie_that_is_not_ours_names_no_session() {
        assert_eq!(read(&headers(&[])), None);
        assert_eq!(read(&headers(&[("cookie", "other=abc.def")])), None);
        assert_eq!(read(&headers(&[("cookie", "weldsuite_signin=")])), None);
        assert_eq!(
            read(&headers(&[("cookie", "weldsuite_signin=no-dot")])),
            None
        );
        assert_eq!(
            read(&headers(&[("cookie", "weldsuite_signin=!!!.???")])),
            None
        );
    }

    #[test]
    fn clearing_expires_the_cookie_and_keeping_sends_nothing() {
        let cleared = header(&Change::Clear, false).expect("header");
        assert_eq!(
            cleared.to_str().expect("text"),
            "weldsuite_signin=; Max-Age=0; Path=/api/sign-in; HttpOnly; SameSite=Strict"
        );
        assert_eq!(header(&Change::Keep, true), None);
    }

    #[test]
    fn only_a_local_server_goes_without_secure() {
        assert!(secure(&headers(&[("host", "app.weldsuite.eu")])));
        assert!(secure(&headers(&[])));
        assert!(!secure(&headers(&[("host", "localhost:8789")])));
        assert!(!secure(&headers(&[("host", "127.0.0.1")])));
        assert!(secure(&headers(&[("host", "localhost.evil.test")])));
    }
}
