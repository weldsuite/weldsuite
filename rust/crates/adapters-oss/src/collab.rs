//! The collab-rooms service (`rust/docs/collab-rooms.md`): WeldDocs' and
//! WeldSheets' rooms in Node, one StatefulSet pod per shard.
//!
//! `POST <pod>/rpc { binding, name, method, args }` answers `200 { result }`,
//! or `500 { error }` when the method threw (the conformance ledger bridge's
//! wire format, so conformance builds use this adapter on the test's bridge).
//! A room's calls and its sockets go to the pod that wins rendezvous hashing
//! on the room id, `sha256("<binding>:<name>")` in hex: the id the room's
//! tickets start with, as `idFromName` is on Global. Engine calls take turns
//! over the pods.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use aws_lc_rs::digest::{SHA256, digest};
use serde_json::{Value, json};
use weldsuite_ports::collab::{CollabError, CollabRooms};
use weldsuite_ports::{BoxFuture, PortError};

/// The header both sides authenticate with.
pub const SECRET_HEADER: &str = "x-internal-secret";

/// The collab-rooms pods, by URL (`http://collab-rooms-0.collab-rooms:8090`).
#[derive(Debug)]
pub struct HttpCollabRooms {
    urls: Vec<String>,
    secret: Option<String>,
    client: reqwest::Client,
    next: AtomicUsize,
}

impl HttpCollabRooms {
    /// `urls` must not be empty.
    pub fn new(urls: Vec<String>, secret: Option<String>) -> Self {
        Self {
            urls: urls
                .into_iter()
                .map(|url| url.trim_end_matches('/').to_owned())
                .collect(),
            secret,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            next: AtomicUsize::new(0),
        }
    }

    /// The id of the room `name` of `binding`: its tickets' prefix.
    pub fn room_id(binding: &str, name: &str) -> String {
        hex::encode(digest(&SHA256, format!("{binding}:{name}").as_bytes()))
    }

    /// The pod that holds room `room_id`.
    pub fn owner(&self, room_id: &str) -> &str {
        let score = |url: &str| {
            let hash = digest(&SHA256, format!("{room_id}\n{url}").as_bytes());
            let mut head = [0u8; 8];
            head.copy_from_slice(&hash.as_ref()[..8]);
            u64::from_be_bytes(head)
        };
        self.urls
            .iter()
            .max_by_key(|url| score(url))
            .map_or("", String::as_str)
    }

    /// The shared secret the pods send and expect.
    pub fn secret(&self) -> Option<&str> {
        self.secret.as_deref()
    }

    fn pod_for(&self, binding: &str, name: &str) -> &str {
        if binding.ends_with("_ROOM") {
            self.owner(&Self::room_id(binding, name))
        } else {
            let turn = self.next.fetch_add(1, Ordering::Relaxed);
            self.urls
                .get(turn % self.urls.len().max(1))
                .map_or("", String::as_str)
        }
    }

    async fn post(
        &self,
        binding: &str,
        name: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, CollabError> {
        let pod = self.pod_for(binding, name);
        let mut request = self
            .client
            .post(format!("{pod}/rpc"))
            .header("content-type", "application/json")
            .body(
                json!({ "binding": binding, "name": name, "method": method, "args": args })
                    .to_string(),
            );
        if let Some(secret) = &self.secret {
            request = request.header(SECRET_HEADER, secret);
        }
        let unavailable = |error: String| CollabError::Unavailable(PortError::backend(error));
        let response = request
            .send()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| unavailable(format!("{binding}.{method}: {error}")))?;
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|error| unavailable(format!("{binding}.{method}: {error}")))?;
        if status.is_success() {
            return Ok(body.get("result").cloned().unwrap_or(Value::Null));
        }
        match body.get("error").and_then(Value::as_str) {
            Some(message) if status.as_u16() == 500 => Err(CollabError::Threw(message.to_owned())),
            _ => Err(unavailable(format!("{binding}.{method} answered {status}"))),
        }
    }
}

impl CollabRooms for HttpCollabRooms {
    fn call<'a>(
        &'a self,
        binding: &'a str,
        name: &'a str,
        method: &'a str,
        args: Value,
    ) -> BoxFuture<'a, Result<Value, CollabError>> {
        Box::pin(self.post(binding, name, method, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_ids_are_the_sha256_of_binding_and_name() {
        assert_eq!(
            HttpCollabRooms::room_id("DOC_ROOM", "org_1:doc_1"),
            hex::encode(digest(&SHA256, b"DOC_ROOM:org_1:doc_1"))
        );
        assert_eq!(HttpCollabRooms::room_id("DOC_ROOM", "x").len(), 64);
    }

    #[test]
    fn a_room_has_one_owner_and_rooms_spread_over_the_pods() {
        let urls: Vec<String> = (0..3)
            .map(|i| format!("http://collab-rooms-{i}:8090/"))
            .collect();
        let rooms = HttpCollabRooms::new(urls.clone(), None);
        let mut seen = std::collections::BTreeMap::new();
        for n in 0..300 {
            let id = HttpCollabRooms::room_id("SHEET_ROOM", &format!("org:{n}"));
            let owner = rooms.owner(&id).to_owned();
            assert_eq!(rooms.owner(&id), owner, "stable");
            *seen.entry(owner).or_insert(0) += 1;
        }
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert!(seen.values().all(|n| *n > 50), "{seen:?}");
        // One more pod moves only the rooms it wins.
        let mut more = urls;
        more.push("http://collab-rooms-3:8090".to_owned());
        let grown = HttpCollabRooms::new(more, None);
        for n in 0..300 {
            let id = HttpCollabRooms::room_id("SHEET_ROOM", &format!("org:{n}"));
            let after = grown.owner(&id);
            assert!(after == rooms.owner(&id) || after == "http://collab-rooms-3:8090");
        }
    }
}
