//! `credentials.ts` and the sealing half of `warmup-pool.ts`: mailbox
//! SMTP/IMAP logins, sealed with the tenant keyring
//! (`DATABASE_ENCRYPTION_KEY(_V2)`) in `reach_mailboxes`, and with
//! `WELDREACH_WARMUP_KEY` (as a v2 key) in the master warmup pool.

use serde_json::{Value, json};
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};

/// `ReachMailServerCredentials`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailServerCredentials {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
    pub password: String,
}

impl MailServerCredentials {
    /// `JSON.stringify(credentials)`, keys in the object's order.
    pub fn to_json_text(&self) -> String {
        format!(
            "{{\"host\":{},\"port\":{},\"tls\":{},\"username\":{},\"password\":{}}}",
            json!(self.host),
            self.port,
            self.tls,
            json!(self.username),
            json!(self.password)
        )
    }

    fn from_json(value: &Value) -> Option<Self> {
        let port = value.get("port")?.as_f64()?;
        Some(Self {
            host: value.get("host")?.as_str()?.to_owned(),
            port: if port.fract() == 0.0 && (0.0..=65535.0).contains(&port) {
                port as u16
            } else {
                return None;
            },
            tls: value.get("tls").and_then(Value::as_bool) != Some(false),
            username: value.get("username")?.as_str()?.to_owned(),
            password: value.get("password")?.as_str()?.to_owned(),
        })
    }
}

/// `sealMailServerCredentials(env, credentials)`.
pub fn seal(keyring: &Keyring, credentials: &MailServerCredentials) -> Result<String, String> {
    encrypt_field(&credentials.to_json_text(), keyring).map_err(|error| error.to_string())
}

/// `openMailServerCredentials(env, blob)`: `None` when missing, undecryptable
/// or malformed.
pub fn open(keyring: &Keyring, blob: Option<&str>) -> Option<MailServerCredentials> {
    let blob = blob.filter(|b| !b.is_empty())?;
    let plain = decrypt_field(blob, keyring).ok()?;
    MailServerCredentials::from_json(&serde_json::from_str(&plain).ok()?)
}

/// The warmup pool's keyring: `{ v2: WELDREACH_WARMUP_KEY }`.
pub fn warmup_keyring(key: &str) -> Keyring {
    Keyring {
        v1: None,
        v2: Some(key.to_owned()),
    }
}
