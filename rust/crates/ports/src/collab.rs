//! The collaborative rooms of WeldDocs and WeldSheets (`rust/docs/collab-rooms.md`):
//! on Global one Durable Object per document (`DocRoom`, `SheetRoom`), on
//! Kubernetes the same classes in the `collab-rooms` Node service. A route
//! calls a room as the workers do, `ns.get(ns.idFromName(name))[method](...args)`,
//! and the engine work it cannot do in Rust (a new document's checkpoint, an
//! import, an export) on the `DOC_ENGINE` / `SHEET_ENGINE` bindings.
//!
//! Values are JSON; bytes travel as `{ "$bytes": "<base64>" }` ([`bytes_value`],
//! [`value_bytes`]). Reach it through the request's [`RequestCollab`]
//! extension when there is one (conformance: the test's own fakes), else the
//! app's.

use std::sync::Arc;

use serde_json::Value;

use crate::{BoxFuture, PortError};

/// The rooms of one binding.
pub const DOC_ROOM: &str = "DOC_ROOM";
pub const SHEET_ROOM: &str = "SHEET_ROOM";
/// The engines' functions.
pub const DOC_ENGINE: &str = "DOC_ENGINE";
pub const SHEET_ENGINE: &str = "SHEET_ENGINE";

/// What a room or engine call can come back with.
#[derive(Debug)]
pub enum CollabError {
    /// The method threw: the room's own error, as the worker would see it.
    Threw(String),
    /// No collab-rooms service is configured, or it could not be reached.
    Unavailable(PortError),
}

impl std::fmt::Display for CollabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Threw(message) => write!(f, "the room threw: {message}"),
            Self::Unavailable(error) => write!(f, "collab rooms unavailable: {error}"),
        }
    }
}

impl std::error::Error for CollabError {}

/// Calls rooms and engines.
pub trait CollabRooms: Send + Sync {
    /// `ns.get(ns.idFromName(name))[method](...args)` on `binding`; `args`
    /// is a JSON array. `null` for a method that returns nothing.
    fn call<'a>(
        &'a self,
        binding: &'a str,
        name: &'a str,
        method: &'a str,
        args: Value,
    ) -> BoxFuture<'a, Result<Value, CollabError>>;
}

/// The rooms a request reaches.
#[derive(Clone)]
pub struct RequestCollab(pub Arc<dyn CollabRooms>);

impl std::fmt::Debug for RequestCollab {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestCollab")
    }
}

/// Bytes as the rooms send them: `{ "$bytes": "<base64>" }`.
pub fn bytes_value(bytes: &[u8]) -> Value {
    serde_json::json!({ "$bytes": base64_encode(bytes) })
}

/// The bytes of a `{ "$bytes": … }` value.
pub fn value_bytes(value: &Value) -> Option<Vec<u8>> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    base64_decode(object.get("$bytes")?.as_str()?)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in text.bytes() {
        if c == b'=' {
            break;
        }
        let v = u32::try_from(ALPHABET.iter().position(|a| *a == c)?).ok()?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_trip_as_base64() {
        for bytes in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0, 255, 128, 7, 9]] {
            let value = bytes_value(bytes);
            assert_eq!(value_bytes(&value).as_deref(), Some(bytes));
        }
        assert_eq!(
            bytes_value(b"hello"),
            serde_json::json!({ "$bytes": "aGVsbG8=" })
        );
        assert_eq!(
            value_bytes(&serde_json::json!({ "$bytes": "aGVsbG8=", "x": 1 })),
            None
        );
    }
}
