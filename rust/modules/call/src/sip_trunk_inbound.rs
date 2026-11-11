//! A call that arrives over a customer's own phone system (SIP trunk / PBX)
//! (`services/sip-trunk-inbound.ts`).
//!
//! The trunk is its own Telnyx connection with call parking on, so the call
//! reaches the Telnyx webhook as `call.initiated` without a client state,
//! like a call to one of our numbers, but on a connection that is neither
//! `TELNYX_CONNECTION_ID` nor `TELNYX_SIP_CONNECTION_ID`. Telnyx calls what
//! a connection originates "outbound", so the payload's `direction` is no
//! guide.
//!
//! A call to a trunk's number is let in only when that trunk exists, is
//! active and owns the connection the call came in on; otherwise it is
//! refused and, when a trunk can be identified, the reason is kept on it.
//! That holds for every way such a call could reach us, not only over a
//! trunk: the trunk's connection is what authenticates the sender.
//!
//! A number we host is never refused here. A phone system that sends a call
//! to one (a colleague dialling the support number from their desk phone)
//! is an ordinary inbound call to that number.

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::{js, now};

/// `isTrunkCall(env, payload)`: whether a `call.initiated` payload (already
/// known to carry no client state) came in over a customer's trunk: it
/// names a connection that is not one of ours. Without
/// `TELNYX_CONNECTION_ID` there is nothing to tell ours from theirs, so
/// nothing counts as a trunk call.
pub(crate) fn is_trunk_call(
    connection: Option<&str>,
    sip_connection: Option<&str>,
    payload: &Value,
) -> bool {
    let Some(own) = connection.filter(|own| !own.is_empty()) else {
        return false;
    };
    match payload["connection_id"].as_str() {
        Some(id) if !id.is_empty() => id != own && Some(id) != sip_connection,
        _ => false,
    }
}

/// `TrunkAdmission`: the trunk the call may continue on, or why it may not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Admission {
    Admitted { trunk_id: String },
    Refused { reason: String },
}

/// A trunk as the gate reads it: `(id, providerConnectionId, status)`.
type TrunkRow = (String, Option<String>, String);

/// `recordError(db, trunkId, message, now)`.
async fn record_error(db: &PgPool, trunk_id: &str, message: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update voip_sip_trunks set last_error = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(trunk_id)
    .bind(message)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `admitTrunkCall(db, { payload, phoneRow, toNumber })`: whether a call to
/// a number of the trunk `sip_trunk_id` may continue; a refusal is kept on
/// a trunk as `lastError`.
pub(crate) async fn admit_trunk_call(
    db: &PgPool,
    payload: &Value,
    sip_trunk_id: &str,
    to_number: &str,
) -> Result<Admission, sqlx::Error> {
    // `String(payload.connection_id ?? '')`.
    let connection_id = match &payload["connection_id"] {
        Value::Null => String::new(),
        other => js::string(other),
    };
    let refused = |reason: String| Ok(Admission::Refused { reason });

    let trunk: Option<TrunkRow> = sqlx::query_as(
        "select id, provider_connection_id, status from voip_sip_trunks where id = $1 limit 1",
    )
    .bind(sip_trunk_id)
    .fetch_optional(db)
    .await?;
    let Some((trunk_id, provider_connection_id, status)) = trunk else {
        return refused(format!("The phone system of {to_number} no longer exists"));
    };

    let own_connection = provider_connection_id
        .as_deref()
        .is_some_and(|own| !own.is_empty() && own == connection_id);
    if !own_connection {
        // The trunk that owns the connection the call came in on, when this
        // workspace has one.
        let by_connection: Option<String> = if connection_id.is_empty() {
            None
        } else {
            sqlx::query_scalar(
                "select id from voip_sip_trunks where provider_connection_id = $1 limit 1",
            )
            .bind(&connection_id)
            .fetch_optional(db)
            .await?
        };
        if let Some(other) = by_connection {
            let reason = format!(
                "{to_number} belongs to another phone system than the one the call came from"
            );
            record_error(db, &other, &reason).await?;
            return refused(reason);
        }
        return refused(format!(
            "{to_number} was called over a connection that is not its phone system's"
        ));
    }
    if status != "active" {
        let reason =
            format!("The phone system is switched off, so the call to {to_number} was refused");
        record_error(db, &trunk_id, &reason).await?;
        return refused(reason);
    }
    Ok(Admission::Admitted { trunk_id })
}

/// `recordTrunkInbound(db, trunkId, now)`: a call came in over the trunk,
/// the sign that its setup works.
pub(crate) async fn record_trunk_inbound(db: &PgPool, trunk_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update voip_sip_trunks set last_inbound_at = $2::timestamp, last_error = null,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(trunk_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_trunk_call_names_a_connection_that_is_not_ours() {
        let own = Some("conn-1");
        let sip = Some("sip-conn-1");
        assert!(is_trunk_call(
            own,
            sip,
            &json!({ "connection_id": "conn-pbx-1" })
        ));
        assert!(!is_trunk_call(
            own,
            sip,
            &json!({ "connection_id": "conn-1" })
        ));
        assert!(!is_trunk_call(
            own,
            sip,
            &json!({ "connection_id": "sip-conn-1" })
        ));
        assert!(!is_trunk_call(own, sip, &json!({})));
        assert!(!is_trunk_call(own, sip, &json!({ "connection_id": "" })));
        assert!(!is_trunk_call(own, sip, &json!({ "connection_id": 7 })));
        // Without our own connection id nothing tells ours from theirs.
        assert!(!is_trunk_call(
            None,
            sip,
            &json!({ "connection_id": "conn-pbx-1" })
        ));
        assert!(!is_trunk_call(
            Some(""),
            sip,
            &json!({ "connection_id": "conn-pbx-1" })
        ));
        // No softphone connection configured: only ours is ours.
        assert!(is_trunk_call(
            own,
            None,
            &json!({ "connection_id": "sip-conn-1" })
        ));
    }
}
