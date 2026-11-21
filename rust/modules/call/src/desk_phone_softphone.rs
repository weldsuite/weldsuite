//! A softphone credential per member (`desk_phone_agents`), and the
//! member's own routes at `/api/desk/phone/softphone`
//! (`services/desk-phone-softphone.ts`, `routes/desk-phone/softphone.ts`).
//!
//! An inbound call can only ring one person when that person's browser is
//! signed in with a credential of its own: the server then dials
//! `sip:<sipUsername>@sip.telnyx.com` and only that credential's browsers
//! ring. (`POST /api/call-intelligence/token` keeps minting from the one
//! credential every member of every workspace shares, for outbound calls.)
//!
//! No entity events: a member's own "take calls" switch and credential are
//! not a catalogued entity.

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data};

use crate::desk_phone_ring::ring_waiting_calls;
use crate::telnyx::Telnyx;
use crate::{CallState, Caller, internal, now, validate};

const CREDENTIAL_NAME_MAX: usize = 64;

/// `/^[A-Za-z0-9-]{1,64}$/`: Telnyx resource ids are UUIDs; anything
/// outside this shape must not reach a request path.
fn is_telnyx_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `softphoneConfigured(env)`: the Telnyx key and the SIP connection are set.
fn configured(caller: &Caller) -> bool {
    caller.env("TELNYX_API_KEY").is_some() && caller.env("TELNYX_SIP_CONNECTION_ID").is_some()
}

/// A member's `desk_phone_agents` row: `(available, telnyxCredentialId,
/// sipUsername)`.
type AgentRow = (bool, Option<String>, Option<String>);

async fn agent_row(db: &PgPool, user_id: &str) -> Result<Option<AgentRow>, sqlx::Error> {
    sqlx::query_as(
        "select available, telnyx_credential_id, sip_username from desk_phone_agents
         where user_id = $1 limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// A stored credential, when the member has one: `(id, sipUsername)`.
fn stored_credential(row: Option<AgentRow>) -> Option<(String, String)> {
    let (_, id, sip_username) = row?;
    Some((
        id.filter(|id| !id.is_empty())?,
        sip_username.filter(|sip| !sip.is_empty())?,
    ))
}

/// `getSoftphone(env, db, userId)`: `SoftphoneState`.
async fn softphone(caller: &Caller) -> Result<Value, sqlx::Error> {
    let row = agent_row(&caller.db, &caller.user_id).await?;
    let available = row.as_ref().is_some_and(|(available, _, _)| *available);
    let sip_username = row.as_ref().and_then(|(_, _, sip)| sip.clone());
    Ok(json!({
        "configured": configured(caller),
        "available": available,
        "registered": stored_credential(row).is_some(),
        "sipUsername": sip_username,
    }))
}

/// `GET /api/desk/phone/softphone`.
pub(crate) async fn state(caller: Caller) -> Response {
    match softphone(&caller).await {
        Ok(state) => Data(state).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `PUT /api/desk/phone/softphone { available }`: the member's "take calls"
/// switch; creates their row on first use. Switched on, they are offered a
/// waiting caller.
pub(crate) async fn set_available(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `updateDeskSoftphoneSchema`.
    let available = match validate(&headers, &body, |issues, fields| {
        issues
            .boolean(fields, "available", Presence::Required)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(available) => available,
        Err(response) => return *response,
    };
    let result = async {
        let before = agent_row(&caller.db, &caller.user_id).await?;
        let was_available = before.is_some_and(|(available, _, _)| available);
        sqlx::query(
            "insert into desk_phone_agents (user_id, available) values ($1, $2)
             on conflict (user_id) do update set available = $2, updated_at = $3::timestamp",
        )
        .bind(&caller.user_id)
        .bind(available)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let after = softphone(&caller).await?;
        Ok::<_, sqlx::Error>((was_available, after))
    }
    .await;
    let (was_available, after) = match result {
        Ok(result) => result,
        Err(error) => return internal(&error, "Internal server error"),
    };
    // Switched on (it was off, or the member is new): offer them a waiting
    // caller.
    if available && !was_available {
        let telnyx = caller.telnyx(&state);
        let org = caller.org();
        ring_waiting_calls(&caller.phone(&state, &telnyx, &org), None).await;
    }
    Data(after).into_response()
}

/// `credentialName(workspaceId, userId)`: `weldsuite-desk-<workspace
/// id>-<user id>`, cut to a length and alphabet Telnyx takes.
fn credential_name(workspace_id: &str, user_id: &str) -> String {
    // `.replace(/[^A-Za-z0-9_-]/g, '-')` works on UTF-16 units.
    format!("weldsuite-desk-{workspace_id}-{user_id}")
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' => {
                char::from(byte)
            }
            _ => '-',
        })
        .take(CREDENTIAL_NAME_MAX)
        .collect()
}

/// `createAndStoreCredential(env, db, { workspaceId, userId, staleId })`:
/// create the member's credential and store it, unless another request
/// stored one first (two tabs asking at once): then ours is deleted and
/// theirs used. `stale_id` is the stored credential Telnyx no longer knows,
/// replaced here.
async fn create_and_store_credential(
    caller: &Caller,
    telnyx: &Telnyx,
    stale_id: Option<&str>,
) -> Result<(String, String), String> {
    let connection_id = caller
        .env("TELNYX_SIP_CONNECTION_ID")
        .ok_or("TELNYX_SIP_CONNECTION_ID is not set")?;
    let name = credential_name(&caller.workspace_id, &caller.user_id);
    let (created_id, created_sip) = telnyx
        .create_credential(&connection_id, &name)
        .await
        .map_err(|error| error.to_string())?;
    if !is_telnyx_id(&created_id) {
        return Err("Unexpected Telnyx credential id format".to_owned());
    }
    let db = &caller.db;
    sqlx::query("insert into desk_phone_agents (user_id) values ($1) on conflict do nothing")
        .bind(&caller.user_id)
        .execute(db)
        .await
        .map_err(|error| error.to_string())?;
    let claimed: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "update desk_phone_agents set telnyx_credential_id = $2, sip_username = $3,
             updated_at = $4::timestamp
         where user_id = $1
           and case when $5::text is null then telnyx_credential_id is null
                    else telnyx_credential_id = $5 end
         returning telnyx_credential_id, sip_username",
    )
    .bind(&caller.user_id)
    .bind(&created_id)
    .bind(&created_sip)
    .bind(now())
    .bind(stale_id.filter(|id| !id.is_empty()))
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    if let Some((Some(id), Some(sip_username))) = claimed
        && !id.is_empty()
        && !sip_username.is_empty()
    {
        return Ok((id, sip_username));
    }
    if let Err(error) = telnyx.delete_credential(&created_id).await {
        tracing::warn!(%error, "[desk-phone] could not delete an unused softphone credential");
    }
    let row = agent_row(db, &caller.user_id)
        .await
        .map_err(|error| error.to_string())?;
    stored_credential(row).ok_or_else(|| "Softphone credential was not stored".to_owned())
}

/// `mintSoftphoneToken(env, db, { workspaceId, userId })`: a login token
/// from the member's own credential, created on first use, as `(token,
/// sipUsername)`. When Telnyx no longer knows the stored credential (404) a
/// new one is created, once.
async fn mint_token(caller: &Caller, telnyx: &Telnyx) -> Result<(String, String), String> {
    let row = agent_row(&caller.db, &caller.user_id)
        .await
        .map_err(|error| error.to_string())?;
    let (id, sip_username) = match stored_credential(row) {
        Some(credential) => credential,
        None => create_and_store_credential(caller, telnyx, None).await?,
    };
    match telnyx.credential_token(&id).await {
        Ok(token) => Ok((token, sip_username)),
        Err(error) if error.status() == Some(404) => {
            let (id, sip_username) = create_and_store_credential(caller, telnyx, Some(&id)).await?;
            let token = telnyx
                .credential_token(&id)
                .await
                .map_err(|error| error.to_string())?;
            Ok((token, sip_username))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// `POST /api/desk/phone/softphone/token`: a WebRTC login token of the
/// member's own credential.
pub(crate) async fn token(State(state): State<CallState>, caller: Caller) -> Response {
    if !configured(&caller) {
        return Data(json!({ "token": null, "configured": false, "sipUsername": null }))
            .into_response();
    }
    let telnyx = caller.telnyx(&state);
    match mint_token(&caller, &telnyx).await {
        Ok((token, sip_username)) => Data(json!({
            "token": token,
            "configured": true,
            "sipUsername": sip_username,
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "[desk-phone] softphone token failed");
            ApiError::internal()
                .with_message("Failed to generate Voice token")
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_names_fit_what_telnyx_takes() {
        assert_eq!(
            credential_name("ws_soft", "user_soft"),
            "weldsuite-desk-ws_soft-user_soft"
        );
        let long = credential_name("ws_soft", &format!("user_{} y/z", "x".repeat(100)));
        assert_eq!(long.len(), 64);
        assert!(long.starts_with("weldsuite-desk-ws_soft-user_xxx"));
        // A character outside the alphabet becomes a dash per UTF-16 unit.
        assert_eq!(credential_name("ws 1", "ü/😀"), "weldsuite-desk-ws-1-----");
        assert!(is_telnyx_id("cred-1"));
        assert!(!is_telnyx_id(""));
        assert!(!is_telnyx_id("../other"));
        assert!(!is_telnyx_id(&"a".repeat(65)));
    }

    #[test]
    fn a_credential_needs_its_id_and_its_sip_username() {
        let row = |id: Option<&str>, sip: Option<&str>| {
            Some((true, id.map(str::to_owned), sip.map(str::to_owned)))
        };
        assert_eq!(
            stored_credential(row(Some("cred-1"), Some("sip1"))),
            Some(("cred-1".to_owned(), "sip1".to_owned()))
        );
        assert_eq!(stored_credential(row(Some("cred-1"), None)), None);
        assert_eq!(stored_credential(row(Some(""), Some("sip1"))), None);
        assert_eq!(stored_credential(None), None);
    }
}
