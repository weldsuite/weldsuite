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
//! A number we host takes a call from a phone system only when that phone
//! system is the destination workspace's own (a colleague dialling the
//! support number from their desk phone), or the connection is the number's
//! own: then it is an ordinary inbound call to that number. Any other
//! trunk's call to it is refused, so one workspace cannot run its calls (and
//! their minutes) into another's number.
//!
//! A trunk's SIP login is in a customer's hands, so a client state on an
//! event of a trunk connection proves nothing by itself: the workspace it
//! names must own that connection (`owns_trunk_connection`).

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::{voip_phone_numbers, voip_sip_trunks as trunks};

use crate::js;

/// `isTrunkCall(env, payload)`: whether an event's payload came in over a
/// customer's trunk: it names a connection that is not one of ours. Without
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
async fn record_error(db: &PgPool, trunk_id: &str, message: &str) -> Result<(), DbErr> {
    trunks::Entity::update_many()
        .col_expr(trunks::Column::LastError, Expr::value(message))
        .col_expr(trunks::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(trunks::Column::Id.eq(trunk_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The trunk that owns the connection, when this workspace has one.
async fn trunk_on_connection(db: &PgPool, connection_id: &str) -> Result<Option<String>, DbErr> {
    trunks::Entity::find()
        .select_only()
        .column(trunks::Column::Id)
        .filter(trunks::Column::ProviderConnectionId.eq(connection_id))
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `admitTrunkCall(db, { payload, phoneRow, toNumber })`: whether a call to
/// a number of the trunk `sip_trunk_id` may continue; a refusal is kept on
/// a trunk as `lastError`.
pub(crate) async fn admit_trunk_call(
    db: &PgPool,
    payload: &Value,
    sip_trunk_id: &str,
    to_number: &str,
) -> Result<Admission, DbErr> {
    // `String(payload.connection_id ?? '')`.
    let connection_id = match &payload["connection_id"] {
        Value::Null => String::new(),
        other => js::string(other),
    };
    let refused = |reason: String| Ok(Admission::Refused { reason });

    let trunk: Option<TrunkRow> = trunks::Entity::find()
        .select_only()
        .columns([
            trunks::Column::Id,
            trunks::Column::ProviderConnectionId,
            trunks::Column::Status,
        ])
        .filter(trunks::Column::Id.eq(sip_trunk_id))
        .limit(1)
        .into_tuple()
        .one(&orm(db))
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
            trunk_on_connection(db, &connection_id).await?
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

/// `String(payload.connection_id ?? '')`.
fn connection_of(payload: &Value) -> String {
    match &payload["connection_id"] {
        Value::Null => String::new(),
        other => js::string(other),
    }
}

/// `hasTrunkOnConnection(db, connectionId)`: whether a phone system of this
/// workspace has the connection.
async fn has_trunk_on_connection(db: &PgPool, connection_id: &str) -> Result<bool, DbErr> {
    Ok(trunk_on_connection(db, connection_id).await?.is_some())
}

/// `admitTrunkCallToHostedNumber(db, { payload, phoneRow })`: whether a call
/// that came in over a trunk connection may reach a number we host (no
/// `sipTrunkId`): the connection is the number's own, or a phone system of
/// this, the destination, workspace has it.
pub(crate) async fn admit_trunk_call_to_hosted_number(
    db: &PgPool,
    payload: &Value,
    number_connection: Option<&str>,
) -> Result<bool, DbErr> {
    let connection_id = connection_of(payload);
    if connection_id.is_empty() {
        return Ok(false);
    }
    if number_connection == Some(connection_id.as_str()) {
        return Ok(true);
    }
    has_trunk_on_connection(db, &connection_id).await
}

/// `ownsTrunkConnection(db, payload)`: whether the workspace of `db` owns
/// the trunk connection an event came in on: one of its phone systems has it,
/// or one of its live numbers is on it (a call
/// `admit_trunk_call_to_hosted_number` let in on the number's own
/// connection). The gate for a client state that names this workspace on
/// such an event.
pub(crate) async fn owns_trunk_connection(db: &PgPool, payload: &Value) -> Result<bool, DbErr> {
    let connection_id = connection_of(payload);
    if connection_id.is_empty() {
        return Ok(false);
    }
    if has_trunk_on_connection(db, &connection_id).await? {
        return Ok(true);
    }
    let number: Option<String> = voip_phone_numbers::Entity::find()
        .select_only()
        .column(voip_phone_numbers::Column::Id)
        .filter(voip_phone_numbers::Column::ProviderConnectionId.eq(&connection_id))
        .filter(voip_phone_numbers::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(number.is_some())
}

/// `recordTrunkInbound(db, trunkId, now)`: a call came in over the trunk,
/// the sign that its setup works.
pub(crate) async fn record_trunk_inbound(db: &PgPool, trunk_id: &str) -> Result<(), DbErr> {
    let now = utc_now();
    trunks::Entity::update_many()
        .col_expr(trunks::Column::LastInboundAt, Expr::value(now))
        .col_expr(
            trunks::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(trunks::Column::UpdatedAt, Expr::value(now))
        .filter(trunks::Column::Id.eq(trunk_id))
        .exec(&orm(db))
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
