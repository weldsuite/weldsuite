//! The fiscal settings of a Brazilian entity (books-api's
//! `br-fiscal/settings`): the Focus environment, the company tokens sealed
//! with the field encryption keys, and the webhooks registered with Focus
//! (a random token in the URL, indexed in the workspace cache; a random
//! secret Focus echoes, kept only as its hash).

use std::sync::Arc;

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::vendor_tax::sha256_hex;
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};
use weldsuite_ports::{DynCache, OutboundHttp};

use super::FiscalError;
use super::focus::{Focus, ProviderError};

/// `FISCAL_ENVIRONMENTS`.
pub(crate) const ENVIRONMENTS: [&str; 2] = ["homologacao", "producao"];
/// `FISCAL_WEBHOOK_EVENTS`.
pub(crate) const WEBHOOK_EVENTS: [&str; 3] = ["nfe", "nfse", "nfsen"];

/// `fiscalHookKvKey(tokenHash)`.
pub(crate) fn hook_key(token_hash: &str) -> String {
    format!("fiscalhook:{token_hash}")
}

/// `fiscalSettingsOf(entity)`.
pub(crate) fn settings_of(entity: &Value) -> Map<String, Value> {
    match entity.get("jurisdictionSettings") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// `fiscalEnvironmentOf(settings)`.
pub(crate) fn environment_of(settings: &Map<String, Value>) -> &'static str {
    if settings.get("fiscalEnvironment").and_then(Value::as_str) == Some("producao") {
        "producao"
    } else {
        "homologacao"
    }
}

/// The sealed tokens: one per environment, in the order they were set.
pub(crate) type Credentials = Vec<(String, String)>;

pub(crate) fn credential<'a>(credentials: &'a Credentials, environment: &str) -> Option<&'a str> {
    credentials
        .iter()
        .find(|(env, _)| env == environment)
        .map(|(_, token)| token.as_str())
}

/// `readFiscalCredentials(entity, env)`.
pub(crate) fn read_credentials(entity: &Value, keyring: &Keyring) -> Result<Credentials, FiscalError> {
    let Some(sealed) = entity
        .get("fiscalCredentialsEncrypted")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(Vec::new());
    };
    let opened = decrypt_field(sealed, keyring)
        .ok()
        .and_then(|plain| serde_json::from_str::<Value>(&plain).ok())
        .filter(Value::is_object);
    let Some(parsed) = opened else {
        tracing::error!("[books-api/br-fiscal] could not open the fiscal credentials");
        return Err(FiscalError::bad(
            "The stored Focus NFe token cannot be read. Enter it again in the fiscal settings.",
        ));
    };
    Ok(ENVIRONMENTS
        .iter()
        .filter_map(|env| {
            parsed
                .get(*env)
                .and_then(Value::as_str)
                .map(|token| ((*env).to_owned(), token.to_owned()))
        })
        .collect())
}

/// `sealFiscalCredentials(credentials, env)`: `None` without any.
pub(crate) fn seal_credentials(
    credentials: &Credentials,
    keyring: &Keyring,
) -> Result<Option<String>, FiscalError> {
    if credentials.is_empty() {
        return Ok(None);
    }
    if keyring.v1.is_none() && keyring.v2.is_none() {
        return Err(FiscalError::bad(
            "Encryption is not configured, so the Focus NFe token can not be stored",
        ));
    }
    let mut object = String::from("{");
    for (i, (env, token)) in credentials.iter().enumerate() {
        if i > 0 {
            object.push(',');
        }
        object.push_str(&format!("{}:{}", json!(env), json!(token)));
    }
    object.push('}');
    encrypt_field(&object, keyring)
        .map(Some)
        .map_err(|error| FiscalError::Refusal(weldsuite_books_domain::http::Refusal::Internal(format!("{error:?}"))))
}

/// `focusClientFor(entity, env, environment)`.
pub(crate) fn client_for(
    entity: &Value,
    keyring: &Keyring,
    environment: &str,
    http: Option<OutboundHttp>,
) -> Result<Focus, FiscalError> {
    let credentials = read_credentials(entity, keyring)?;
    let Some(token) = credential(&credentials, environment).filter(|t| !t.is_empty()) else {
        let which = if environment == "producao" {
            "production"
        } else {
            "homologation"
        };
        return Err(FiscalError::bad(format!(
            "No Focus NFe token is set for {which}. Add it in the fiscal settings."
        )));
    };
    Ok(Focus::new(token, environment, http))
}

/// `timingSafeEqualHex(a, b)`.
pub(crate) fn timing_safe_equal_hex(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// 32 random bytes, base64url without padding.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        tracing::error!("[books-api/br-fiscal] no randomness for a webhook token");
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `removeFiscalWebhooks(client, env, previous)`: the cache entry, then the
/// hooks (best effort).
pub(crate) async fn remove_webhooks(
    client: Option<&Focus>,
    cache: Option<&Arc<dyn DynCache>>,
    previous: Option<&Value>,
) -> Result<(), FiscalError> {
    let Some(previous) = previous.filter(|p| p.is_object()) else {
        return Ok(());
    };
    let token_hash = previous["tokenHash"].as_str().unwrap_or("undefined");
    if let Some(cache) = cache {
        cache
            .delete_boxed(&hook_key(token_hash))
            .await
            .map_err(|error| FiscalError::Refusal(weldsuite_books_domain::http::Refusal::Internal(format!("{error:?}"))))?;
    }
    let Some(client) = client else {
        return Ok(());
    };
    for hook in previous["hooks"].as_array().cloned().unwrap_or_default() {
        let id = match &hook["id"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        // A hook already gone, or a token that lost access: nothing left to clean up.
        let _ = client.delete_hook(&id).await;
    }
    Ok(())
}

/// What a registration left: the stored config, the URL (shown once) and
/// the events Focus refused.
pub(crate) struct Registered {
    pub config: Value,
    pub url: String,
    pub failures: Vec<String>,
}

/// Why a registration failed altogether.
pub(crate) enum RegisterError {
    Provider(ProviderError),
    Fiscal(FiscalError),
}

/// `registerFiscalWebhooks(args)`.
pub(crate) async fn register_webhooks(
    client: &Focus,
    cache: Option<&Arc<dyn DynCache>>,
    org_id: &str,
    entity_id: &str,
    environment: &str,
    base_url: &str,
    previous: Option<&Value>,
) -> Result<Registered, RegisterError> {
    remove_webhooks(Some(client), cache, previous)
        .await
        .map_err(RegisterError::Fiscal)?;
    let token = random_token();
    let secret = random_token();
    let url = format!(
        "{}/public/fiscal-webhooks/{token}",
        base_url.trim_end_matches('/')
    );
    let mut hooks = Vec::new();
    let mut failures = Vec::new();
    let mut last_error = None;
    for event in WEBHOOK_EVENTS {
        match client.create_hook(event, &url, &secret).await {
            Ok(res) => match &res.data["id"] {
                Value::String(id) => hooks.push(json!({ "id": id, "event": event })),
                Value::Number(id) => hooks.push(json!({ "id": id.to_string(), "event": event })),
                _ => {}
            },
            Err(error) => {
                failures.push(format!("{event}: {}", error.detail()));
                last_error = Some(error);
            }
        }
    }
    if hooks.is_empty()
        && let Some(error) = last_error
    {
        return Err(RegisterError::Provider(error));
    }
    let token_hash = sha256_hex(&token);
    let secret_hash = sha256_hex(&secret);
    let config = json!({
        "tokenHash": token_hash,
        "secretHash": secret_hash,
        "hooks": hooks,
        "registeredAt": weldsuite_books_domain::http::now(),
    });
    let entry = json!({
        "orgId": org_id,
        "entityId": entity_id,
        "environment": environment,
        "secretHash": secret_hash,
    });
    if let Some(cache) = cache {
        cache
            .put_boxed(&hook_key(&token_hash), &entry.to_string(), None)
            .await
            .map_err(|error| {
                RegisterError::Fiscal(FiscalError::Refusal(
                    weldsuite_books_domain::http::Refusal::Internal(format!("{error:?}")),
                ))
            })?;
    } else {
        return Err(RegisterError::Fiscal(FiscalError::Refusal(
            weldsuite_books_domain::http::Refusal::Internal("WORKSPACE_CACHE is not bound".into()),
        )));
    }
    Ok(Registered {
        config,
        url,
        failures,
    })
}
