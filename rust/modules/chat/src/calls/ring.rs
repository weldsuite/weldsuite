//! Ringing a DM call and ending a ring: the realtime ring and push for each
//! member, the signed ring token their phone declines with
//! (`@weldsuite/chat-domain/call-ring-token`), the ring timeout (here the
//! durable `chat.call-ring-timeout` job in place of `scheduleRingTimeout`'s
//! `waitUntil` sleep), declining (`services/chat/decline-call.ts`) and
//! stopping a ring that was answered (`services/chat/call-ring.ts`).

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_chat_domain::Realtime;
use weldsuite_chat_domain::calls::{
    CallPorts, RING_TIMEOUT_MS, call_notice_metadata, call_row, cancel_call_rings,
    dm_call_recipients, insert_call_notice, iso_of_ms, now_ms, parse_ms, participants_of,
    ring_timed_out, room_of, teardown_room, text, truthy, was_answered,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_notifications::{
    CallCancelReason, Notifier, cancel_incoming_call_push, chat as notify, create_and_deliver,
};
use weldsuite_ports::video_rooms::DynVideoRooms;
use weldsuite_ports::{
    BoxFuture, DynCache, DynJobs, DynRealtimePublisher, Job, JobContext, JobError, JobRequest,
    StepRetry, step,
};

use crate::pins::TenantDatabases;

/// How long a ring token works (`CALL_RING_TOKEN_TTL_MS`): the phone's ring
/// stops after 60s.
const CALL_RING_TOKEN_TTL_MS: i64 = 2 * 60_000;

/// How long a phone rings for a call (`CALL_RING_TTL_MS` of
/// `@weldsuite/notifications`).
const CALL_RING_TTL_MS: i64 = 60_000;

/// The ring timeout job's name.
pub const CALL_RING_TIMEOUT_JOB: &str = "chat.call-ring-timeout";

// ============================================================================
// Ring tokens
// ============================================================================

/// Who a ring token was given to (`CallRingClaims`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RingClaims {
    /// The workspace (resolves the tenant database).
    pub(crate) org: String,
    /// The ringing recipient.
    pub(crate) user: String,
    pub(crate) call: String,
}

fn mac(secret: &str) -> Option<Hmac<Sha256>> {
    Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()
}

/// `signCallRingToken(secret, claims, now)`:
/// `<base64url(claims)>.<base64url(HMAC-SHA256(secret, that))>`.
pub(crate) fn sign_ring_token(secret: &str, claims: &RingClaims, now: i64) -> Option<String> {
    // JSON.stringify's key order: o, u, c, e.
    let encoded = format!(
        "{{\"o\":{},\"u\":{},\"c\":{},\"e\":{}}}",
        json!(claims.org),
        json!(claims.user),
        json!(claims.call),
        now + CALL_RING_TOKEN_TTL_MS
    );
    let body = URL_SAFE_NO_PAD.encode(encoded.as_bytes());
    let mut mac = mac(secret)?;
    mac.update(body.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{body}.{signature}"))
}

/// base64url, padded or not (`atob` after swapping the alphabet).
fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).ok()
}

/// `verifyCallRingToken(secret, token, now)`: the claims of a genuine,
/// unexpired token. Never fails.
pub(crate) fn verify_ring_token(secret: Option<&str>, token: &str, now: i64) -> Option<RingClaims> {
    let secret = secret.filter(|s| !s.is_empty())?;
    let mut parts = token.split('.');
    let (body, signature) = (parts.next()?, parts.next()?);
    if body.is_empty() || signature.is_empty() || parts.next().is_some() {
        return None;
    }
    let signature = decode_base64url(signature)?;
    let mut mac = mac(secret)?;
    mac.update(body.as_bytes());
    // Constant-time.
    mac.verify_slice(&signature).ok()?;
    let claims: Value = serde_json::from_slice(&decode_base64url(body)?).ok()?;
    let field = |key: &str| claims.get(key).and_then(Value::as_str).map(str::to_owned);
    let expires = claims.get("e").and_then(Value::as_f64)?;
    #[allow(clippy::cast_precision_loss)]
    if expires < now as f64 {
        return None;
    }
    Some(RingClaims {
        org: field("o")?,
        user: field("u")?,
        call: field("c")?,
    })
}

// ============================================================================
// Ringing
// ============================================================================

/// Who rings whom (`IncomingCallParams`).
#[derive(Debug, Clone)]
pub(crate) struct Ring {
    pub(crate) org_id: String,
    pub(crate) caller_id: String,
    pub(crate) channel_id: String,
    pub(crate) call_type: String,
    pub(crate) call_id: String,
    pub(crate) caller_name: String,
    pub(crate) caller_avatar: Option<String>,
    /// `CALL_RING_SECRET`, for the ring tokens.
    pub(crate) secret: Option<String>,
}

/// `ringDmMember(p, memberUserId)`: the realtime ring, then the push with
/// its ring token. Never fails.
pub(crate) async fn ring_member(db: &PgPool, ports: &CallPorts, ring: &Ring, member: &str) {
    let mut data = Map::new();
    data.insert("callId".into(), json!(ring.call_id));
    data.insert("channelId".into(), json!(ring.channel_id));
    data.insert("callType".into(), json!(ring.call_type));
    data.insert("callerName".into(), json!(ring.caller_name));
    if let Some(avatar) = &ring.caller_avatar {
        data.insert("callerAvatar".into(), json!(avatar));
    }
    ports
        .realtime
        .call_incoming(&ring.org_id, member, data)
        .await;
    let decline_token = ring.secret.as_deref().and_then(|secret| {
        sign_ring_token(
            secret,
            &RingClaims {
                org: ring.org_id.clone(),
                user: member.to_owned(),
                call: ring.call_id.clone(),
            },
            now_ms(),
        )
    });
    let params = notify::incoming_call(
        &ring.org_id,
        member,
        &ring.caller_id,
        &ring.caller_name,
        ring.caller_avatar.as_deref(),
        &ring.channel_id,
        &ring.call_id,
        &ring.call_type,
        decline_token.as_deref(),
    );
    if let Err(error) = create_and_deliver(db, &ports.notifier, &params).await {
        tracing::error!(%error, "[Chat:Calls] Incoming-call notification failed");
    }
}

/// Every DM member but the caller, rung one after another.
pub(crate) async fn ring_dm_members(db: &PgPool, ports: &CallPorts, ring: &Ring) {
    let members: Result<Vec<String>, sqlx::Error> =
        sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
            .bind(&ring.channel_id)
            .fetch_all(db)
            .await;
    match members {
        Ok(members) => {
            for member in members.iter().filter(|m| **m != ring.caller_id) {
                ring_member(db, ports, ring, member).await;
            }
        }
        Err(error) => tracing::error!(%error, "[Chat:Calls] Incoming-call ring failed"),
    }
}

/// `scheduleRingTimeout`: end the call as missed if nobody answered it
/// within [`RING_TIMEOUT_MS`]. Started as a delayed job, so it survives the
/// replica that started it.
pub(crate) async fn schedule_ring_timeout(
    jobs: Option<&Arc<dyn DynJobs>>,
    org_id: &str,
    call_id: &str,
) {
    let Some(jobs) = jobs else {
        return;
    };
    let request = JobRequest {
        name: CALL_RING_TIMEOUT_JOB.to_owned(),
        key: format!("ring-{call_id}"),
        payload: json!({ "orgId": org_id, "callId": call_id }),
        delay: Some(Duration::from_millis(
            u64::try_from(RING_TIMEOUT_MS).unwrap_or_default(),
        )),
    };
    if let Err(error) = jobs.start_boxed(request).await {
        tracing::error!(%error, call_id, "[Chat:Calls] Ring timeout could not be scheduled");
    }
}

/// The `chat.call-ring-timeout` job: [`ring_timed_out`] for the payload's
/// call, outside any request.
pub struct CallRingTimeoutJob {
    pub tenants: TenantDatabases,
    pub video: Arc<dyn DynVideoRooms>,
    pub cache: Option<Arc<dyn DynCache>>,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The missed-call pushes and ring cancels.
    pub notifier: Notifier,
}

impl std::fmt::Debug for CallRingTimeoutJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CallRingTimeoutJob")
    }
}

impl Job for CallRingTimeoutJob {
    fn name(&self) -> &'static str {
        CALL_RING_TIMEOUT_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let org_id = payload["orgId"].as_str().unwrap_or_default().to_owned();
            let call_id = payload["callId"].as_str().unwrap_or_default().to_owned();
            if org_id.is_empty() || call_id.is_empty() {
                return Ok(());
            }
            let retry = StepRetry::exponential(3, Duration::from_secs(5));
            step(ctx, "end-unanswered-call", retry, || {
                let (org_id, call_id) = (org_id.clone(), call_id.clone());
                async move {
                    let db = (self.tenants)(org_id.clone())
                        .await
                        .map_err(JobError::failed)?;
                    let ports = CallPorts {
                        video: Arc::clone(&self.video),
                        cache: self.cache.clone(),
                        realtime: Realtime::new(self.realtime.clone()),
                        notifier: self.notifier.clone(),
                    };
                    ring_timed_out(&db, &ports, &org_id, &call_id).await;
                    Ok::<(), JobError>(())
                }
            })
            .await
        })
    }
}

// ============================================================================
// Declining and answering
// ============================================================================

/// `isRinging(call)`: start-and-join creates the call active with the caller
/// in it, so an unanswered active call is still ringing.
pub(crate) fn is_ringing(call: &Value) -> bool {
    match text(call, "status") {
        Some("ringing") => true,
        Some("active") => !was_answered(call),
        _ => false,
    }
}

/// `declineRingingCall(db, env, orgId, call, declinerId)`: end the ringing
/// call as declined. `false` when it was not ringing (nothing changed).
pub(crate) async fn decline_ringing_call(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    call: &Value,
    decliner_id: &str,
) -> Result<bool, sqlx::Error> {
    if !is_ringing(call) {
        return Ok(false);
    }
    let call_id = text(call, "id").unwrap_or_default();
    let channel_id = text(call, "channelId").unwrap_or_default();
    let initiator_id = text(call, "initiatorId").unwrap_or_default();
    let initiator_name = text(call, "initiatorName").unwrap_or_default();
    let call_type = text(call, "callType").unwrap_or_default();
    let now_ms = now_ms();
    let now = iso_of_ms(now_ms);

    let mut metadata = call
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("declinedBy".into(), json!(decliner_id));
    sqlx::query(
        "update chat_calls set status = 'declined', ended_at = $2::timestamp,
             updated_at = $2::timestamp, metadata = $3
         where id = $1",
    )
    .bind(call_id)
    .bind(&now)
    .bind(Value::Object(metadata))
    .execute(db)
    .await?;

    if let Some(room) = room_of(call) {
        teardown_room(
            ports,
            room,
            call_id,
            Some(org_id),
            Some(channel_id),
            Some(now_ms),
        )
        .await;
    }

    let message_id = generate_id("msg");
    let notice = call_notice_metadata(call_id, call_type, "ended", Some("declined"), Some(0));
    insert_call_notice(
        db,
        &message_id,
        channel_id,
        initiator_id,
        initiator_name,
        None,
        "Missed call",
        &notice,
        &now,
    )
    .await?;
    sqlx::query("update chat_calls set end_message_id = $2 where id = $1")
        .bind(call_id)
        .bind(&message_id)
        .execute(db)
        .await?;

    ports
        .realtime
        .call(channel_id, call_id, decliner_id, "ended")
        .await;
    if let Err(error) = weldsuite_chat_domain::calls::broadcast_call_to_members(
        db,
        &ports.realtime,
        org_id,
        channel_id,
        "ended",
        weldsuite_chat_domain::publish::object([("callId", Some(json!(call_id)))]),
    )
    .await
    {
        tracing::error!(%error, "[Chat:Calls] Realtime publish failed");
    }

    // The decline ends the call for everyone it rang, and the decliner's
    // other phones are still ringing.
    let recipients = dm_call_recipients(db, channel_id, initiator_id).await;
    cancel_call_rings(
        db,
        &ports.notifier,
        call_id,
        &recipients,
        CallCancelReason::Declined,
    )
    .await;

    if decliner_id != initiator_id {
        let name: Result<Option<Option<String>>, sqlx::Error> =
            sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
                .bind(initiator_id)
                .fetch_optional(db)
                .await;
        match name {
            Ok(name) => {
                let caller_name = name.flatten().unwrap_or_else(|| initiator_name.to_owned());
                let params = notify::missed_call(
                    org_id,
                    decliner_id,
                    initiator_id,
                    &caller_name,
                    channel_id,
                    call_id,
                    call_type,
                );
                if let Err(error) = create_and_deliver(db, &ports.notifier, &params).await {
                    tracing::error!(%error, "[Chat:Calls] Missed-call notification failed");
                }
            }
            Err(error) => {
                tracing::error!(%error, "[Chat:Calls] Missed-call notification failed");
            }
        }
    }
    Ok(true)
}

/// `joinAnswersRing(db, call, userId)`: the join answers a ring still going
/// on the user's phones. `call` as it was before the join.
async fn join_answers_ring(db: &PgPool, call: &Value, user_id: &str, now: i64) -> bool {
    if text(call, "initiatorId") == Some(user_id) {
        return false;
    }
    if participants_of(call)
        .iter()
        .any(|p| text(p, "userId") == Some(user_id) && truthy(p.get("joinedAt")))
    {
        return false;
    }
    let created = text(call, "createdAt").and_then(parse_ms);
    if created.is_none_or(|created| now - created > CALL_RING_TTL_MS) {
        return false;
    }
    let channel_id = text(call, "channelId").unwrap_or_default();
    let initiator = text(call, "initiatorId").unwrap_or_default();
    dm_call_recipients(db, channel_id, initiator)
        .await
        .iter()
        .any(|member| member == user_id)
}

/// `cancelRingOnAnswer(db, env, call, userId)`: the join answered the ring,
/// so stop it on the user's other phones. Never fails.
pub(crate) async fn cancel_ring_on_answer(
    db: &PgPool,
    notifier: &Notifier,
    call: &Value,
    user_id: &str,
) {
    if !join_answers_ring(db, call, user_id, now_ms()).await {
        return;
    }
    let call_id = text(call, "id").unwrap_or_default();
    cancel_incoming_call_push(db, notifier, user_id, call_id, CallCancelReason::Answered).await;
}

/// The latest the database can tell (`call_row`), for the public decline.
pub(crate) async fn load_call(db: &PgPool, call_id: &str) -> Result<Option<Value>, sqlx::Error> {
    call_row(db, call_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> RingClaims {
        RingClaims {
            org: "ws_1".to_owned(),
            user: "user_2".to_owned(),
            call: "call_3".to_owned(),
        }
    }

    #[test]
    fn ring_tokens_round_trip_and_expire() {
        let now = 1_800_000_000_000;
        let token = sign_ring_token("secret", &claims(), now).unwrap_or_default();
        assert_eq!(
            verify_ring_token(Some("secret"), &token, now),
            Some(claims())
        );
        // Another secret, an expired token, a tampered one, no secret.
        assert_eq!(verify_ring_token(Some("other"), &token, now), None);
        assert_eq!(
            verify_ring_token(Some("secret"), &token, now + CALL_RING_TOKEN_TTL_MS + 1),
            None
        );
        assert_eq!(
            verify_ring_token(Some("secret"), &format!("{token}x"), now),
            None
        );
        assert_eq!(
            verify_ring_token(Some("secret"), &format!("{token}.x"), now),
            None
        );
        assert_eq!(verify_ring_token(None, &token, now), None);
        // The claims read as TypeScript writes them.
        let body = token.split('.').next().unwrap_or_default();
        let json =
            String::from_utf8(decode_base64url(body).unwrap_or_default()).unwrap_or_default();
        assert_eq!(
            json,
            format!(
                "{{\"o\":\"ws_1\",\"u\":\"user_2\",\"c\":\"call_3\",\"e\":{}}}",
                now + 120_000
            )
        );
    }

    #[test]
    fn an_unanswered_active_call_still_rings() {
        let call = |status: &str, joined: &[&str]| {
            let participants: Vec<Value> = joined
                .iter()
                .map(|user| json!({ "userId": user, "joinedAt": "2026-01-01T10:00:00.000Z" }))
                .collect();
            json!({ "status": status, "initiatorId": "a", "participants": participants })
        };
        assert!(is_ringing(&call("ringing", &[])));
        assert!(is_ringing(&call("active", &["a"])));
        assert!(!is_ringing(&call("active", &["a", "b"])));
        assert!(!is_ringing(&call("ended", &["a"])));
    }
}
