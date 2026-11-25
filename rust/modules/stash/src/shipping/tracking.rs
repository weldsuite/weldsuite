//! Parcel tracking (ADR STASH-013): each parcel carries
//! `tracking_next_check_at`; making labels and shipping mark the workspace
//! due under [`TRACKING_KIND`]; the `stash-parcel-tracking` cron lists due
//! workspaces only, polls their due parcels (at most [`BATCH`] per run),
//! writes the new events and status, and stores when the workspace is due
//! next. It never opens a tenant the index doesn't list.
//!
//! When every outbound piece of a shipment is delivered the shipment is
//! too, and the order gets its `delivered_at`. A voided label on WeldSuite's
//! contract keeps being watched for 14 days: if the carrier scans it anyway,
//! the label is charged again (ADR STASH-012).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{PARCEL_DELIVERED, PARCEL_UPDATED, SHIPMENT_DELIVERED};
use weldsuite_db::due_index::{self, SweepResult};
use weldsuite_db::{Keyring, PgPool, orm, utc_timestamp};
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource, publish_entity_event};
use weldsuite_ports::{BoxFuture, OutboundHttp};
use weldsuite_schema::tenant::{orders, parcels, shipments};
use weldsuite_shipping_domain::{
    CarrierClient, CarrierCode, CarrierError, Credentials, ParcelStatus, TrackRef, Tracking,
    dhl_parcel_nl,
};

use super::accounts::{self, Account};
use super::billing;
use super::parcels::{country_of, iso, postal_code_of, view};

/// The due index kind of parcel tracking.
pub const TRACKING_KIND: &str = "stash_parcel_tracking";
/// Parcels polled per workspace per run.
const BATCH: u64 = 200;

/// When to poll a parcel next, by its status; `None` stops polling.
pub(crate) fn next_check(
    status: &str,
    is_return: bool,
    created_at: PrimitiveDateTime,
    now: PrimitiveDateTime,
    watch_cancelled: bool,
) -> Option<PrimitiveDateTime> {
    let age = now - created_at;
    let (every, until) = match status {
        "cancelled" if watch_cancelled => (Duration::hours(12), Duration::days(14)),
        "delivered" | "returned" | "draft" | "labelling" | "cancelled" => return None,
        "label_created" if is_return => (Duration::days(1), Duration::days(60)),
        "label_created" => (Duration::hours(4), Duration::days(14)),
        "shipped" => (Duration::hours(4), Duration::days(30)),
        "at_service_point" | "exception" => (Duration::hours(6), Duration::days(30)),
        _ => (Duration::hours(2), Duration::days(30)),
    };
    (age <= until).then_some(now + every)
}

/// The first poll of a new label.
pub(crate) fn first_check(now: PrimitiveDateTime, is_return: bool) -> Option<PrimitiveDateTime> {
    next_check("label_created", is_return, now, now, false)
}

/// What one tracking answer changed.
#[derive(Debug, Clone)]
pub(crate) struct Applied {
    pub(crate) row: parcels::Model,
    pub(crate) changed: bool,
    pub(crate) delivered_now: bool,
    /// A voided label on WeldSuite's contract the carrier scanned anyway.
    pub(crate) rescanned: bool,
    /// The shipment that is delivered now.
    pub(crate) shipment_delivered: Option<String>,
}

/// Why a poll failed.
#[derive(Debug)]
pub(crate) enum PollError {
    Carrier(CarrierError),
    Database(DbErr),
}

impl From<DbErr> for PollError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

fn contract_of(row: &parcels::Model) -> Option<String> {
    row.shipping_cost
        .as_ref()
        .and_then(|cost| cost.get("contract"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn event_key(event: &Value) -> (String, String) {
    (
        event
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        event
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    )
}

/// Merge the carrier's answer into the row and store it.
pub(crate) async fn apply(
    db: &PgPool,
    row: &parcels::Model,
    tracking: Option<&Tracking>,
    now: PrimitiveDateTime,
) -> Result<Applied, DbErr> {
    let mut history: Vec<Value> = row
        .status_history
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let known: HashSet<(String, String)> = history.iter().map(event_key).collect();
    let mut grew = false;
    if let Some(tracking) = tracking {
        for event in &tracking.events {
            let value = json!({
                "at": event.at.map(|at| iso(utc_timestamp(at))),
                "code": event.code,
                "description": event.description,
                "location": event.location,
            });
            if !known.contains(&event_key(&value)) {
                history.push(value);
                grew = true;
            }
        }
    }
    history.sort_by(|a, b| event_key(a).0.cmp(&event_key(b).0));
    let previous = row.status.clone();
    let carrier = tracking.map(|t| t.status);
    let mut status = previous.clone();
    let mut rescanned = false;
    match (previous.as_str(), carrier) {
        (_, None) | ("draft" | "labelling", _) | ("shipped", Some(ParcelStatus::LabelCreated)) => {}
        ("cancelled", Some(found)) => rescanned = found != ParcelStatus::LabelCreated,
        (_, Some(found)) => found.as_str().clone_into(&mut status),
    }
    let last = tracking.and_then(|t| t.events.last());
    let is_return = row.is_return == Some(true);
    let watch =
        status == "cancelled" && !rescanned && contract_of(row).as_deref() == Some("weldsuite");
    let next = next_check(&status, is_return, row.created_at, now, watch);
    let delivered_at = tracking
        .and_then(|t| t.delivered_at)
        .map(utc_timestamp)
        .filter(|_| status == "delivered")
        .or(row.actual_delivery_date);
    let estimated = tracking
        .and_then(|t| t.estimated_delivery)
        .map(utc_timestamp)
        .or(row.estimated_delivery_date);
    let changed = grew || status != previous;
    let updated = parcels::ActiveModel {
        id: Unchanged(row.id.clone()),
        status: Set(status.clone()),
        status_history: Set(Some(Value::Array(history))),
        last_scan_date: Set(last
            .and_then(|e| e.at)
            .map(utc_timestamp)
            .or(row.last_scan_date)),
        last_scan_location: Set(last
            .and_then(|e| e.location.clone())
            .or_else(|| row.last_scan_location.clone())),
        actual_delivery_date: Set(delivered_at),
        estimated_delivery_date: Set(estimated),
        tracking_next_check_at: Set(next),
        updated_at: Set(if changed { now } else { row.updated_at }),
        ..Default::default()
    }
    .update(&orm(db))
    .await?;
    let delivered_now = status == "delivered" && previous != "delivered";
    let mut shipment_delivered = None;
    if delivered_now && !is_return {
        shipment_delivered = settle_delivered(db, &updated, now).await?;
    }
    Ok(Applied {
        row: updated,
        changed,
        delivered_now,
        rescanned,
        shipment_delivered,
    })
}

/// A delivered piece: the shipment is delivered when all its outbound
/// pieces are, the order gets `delivered_at` when all of its are.
async fn settle_delivered(
    db: &PgPool,
    row: &parcels::Model,
    now: PrimitiveDateTime,
) -> Result<Option<String>, DbErr> {
    let outbound = || {
        Condition::all()
            .add(parcels::Column::DeletedAt.is_null())
            .add(parcels::Column::Status.ne("cancelled"))
            .add(
                Condition::any()
                    .add(parcels::Column::IsReturn.is_null())
                    .add(parcels::Column::IsReturn.eq(false)),
            )
    };
    let undelivered = |condition: Condition| {
        parcels::Entity::find()
            .select_only()
            .column(parcels::Column::Id)
            .filter(outbound())
            .filter(condition)
            .filter(parcels::Column::Status.ne("delivered"))
            .into_tuple::<String>()
    };
    let mut delivered_shipment = None;
    if let Some(shipment) = &row.shipment_id {
        let left =
            undelivered(Condition::all().add(parcels::Column::ShipmentId.eq(shipment.as_str())))
                .all(&orm(db))
                .await?;
        if left.is_empty() {
            shipments::Entity::update_many()
                .col_expr(shipments::Column::Status, Expr::value("delivered"))
                .col_expr(shipments::Column::DeliveredAt, Expr::value(now))
                .col_expr(shipments::Column::UpdatedAt, Expr::value(now))
                .filter(shipments::Column::Id.eq(shipment.as_str()))
                .exec(&orm(db))
                .await?;
            delivered_shipment = Some(shipment.clone());
        }
    }
    if let Some(order) = &row.order_id {
        let left = undelivered(
            Condition::all()
                .add(parcels::Column::OrderId.eq(order.as_str()))
                .add(parcels::Column::CarrierCode.is_not_null()),
        )
        .all(&orm(db))
        .await?;
        if left.is_empty() {
            orders::Entity::update_many()
                .col_expr(orders::Column::DeliveredAt, Expr::value(now))
                .col_expr(orders::Column::UpdatedAt, Expr::value(now))
                .filter(orders::Column::Id.eq(order.as_str()))
                .exec(&orm(db))
                .await?;
        }
    }
    Ok(delivered_shipment)
}

/// A client that can track the parcel: its account's, or for DHL (whose
/// tracking needs no key) a keyless one when the account is gone.
pub(crate) async fn client_for(
    db: &PgPool,
    row: &parcels::Model,
    code: CarrierCode,
    http: OutboundHttp,
    keyring: &Keyring,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<Option<CarrierClient>, DbErr> {
    if let Some(id) = &row.carrier_id
        && let Some(account_row) = accounts::load(db, id).await?
        && let Ok(account) = Account::of(&account_row)
        && let Ok(client) = account.client(http.clone(), keyring, env)
    {
        return Ok(Some(client));
    }
    Ok(match code {
        CarrierCode::DhlParcelNl => Some(CarrierClient::new(
            Credentials::DhlParcelNl(dhl_parcel_nl::Credentials {
                user_id: String::new(),
                api_key: String::new(),
                account_id: String::new(),
                sandbox: false,
            }),
            http,
        )),
        CarrierCode::PostNl => None,
    })
}

fn track_ref(row: &parcels::Model) -> Option<TrackRef> {
    Some(TrackRef {
        tracking_number: row.tracking_number.clone()?,
        postal_code: postal_code_of(row),
        country: country_of(row),
    })
}

/// Poll the carrier for one parcel and store what it says.
pub(crate) async fn poll(
    db: &PgPool,
    client: &CarrierClient,
    row: &parcels::Model,
) -> Result<Applied, PollError> {
    let now = weldsuite_db::utc_now();
    let Some(piece) = track_ref(row) else {
        return Ok(apply(db, row, None, now).await?);
    };
    let tracking = client.track(&piece).await.map_err(PollError::Carrier)?;
    Ok(apply(db, row, tracking.as_ref(), now).await?)
}

/// The entity events of an applied answer.
pub(crate) fn publish(context: &EventContext, publisher: &EntityEventPublisher, applied: &Applied) {
    let row = &applied.row;
    if applied.changed {
        publish_entity_event(publisher, context, PARCEL_UPDATED, &row.id, &view(row));
    }
    if applied.delivered_now {
        publish_entity_event(
            publisher,
            context,
            PARCEL_DELIVERED,
            &row.id,
            &json!({
                "id": row.id,
                "trackingNumber": row.tracking_number,
                "orderId": row.order_id,
                "orderNumber": row.order_number,
                "carrierCode": row.carrier_code,
                "deliveredAt": row.actual_delivery_date.map(iso),
            }),
        );
    }
    if let Some(shipment) = &applied.shipment_delivered {
        publish_entity_event(
            publisher,
            context,
            SHIPMENT_DELIVERED,
            shipment,
            &json!({ "id": shipment, "status": "delivered" }),
        );
    }
}

/// The earliest next check of the workspace's parcels.
async fn earliest(db: &PgPool) -> Result<Option<PrimitiveDateTime>, DbErr> {
    let next: Option<Option<PrimitiveDateTime>> = parcels::Entity::find()
        .select_only()
        .column(parcels::Column::TrackingNextCheckAt)
        .filter(parcels::Column::TrackingNextCheckAt.is_not_null())
        .filter(parcels::Column::DeletedAt.is_null())
        .order_by_asc(parcels::Column::TrackingNextCheckAt)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(next.flatten())
}

/// Make sure the sweep looks at the workspace by the row's next check.
pub(crate) async fn mark_due(master: &PgPool, workspace_id: &str, row: &parcels::Model) {
    if let Some(at) = row.tracking_next_check_at {
        due_index::mark_due(master, TRACKING_KIND, workspace_id, at.assume_utc()).await;
    }
}

/// Re-derive the workspace's due time (after a refresh or a ship).
pub(crate) async fn reschedule(master: &PgPool, db: &PgPool, workspace_id: &str) {
    due_index::sync_due(master, TRACKING_KIND, workspace_id, || async {
        earliest(db)
            .await
            .map(|at| at.map(PrimitiveDateTime::assume_utc))
    })
    .await;
}

/// Opens a workspace's tenant database: `(pool, Clerk org id)`.
pub type TrackingTenants = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<(PgPool, Option<String>), String>> + Send + Sync,
>;

/// Reads the install's environment (WeldSuite's contract, the keyring).
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What the sweep runs with.
pub struct TrackingSweep {
    pub master: PgPool,
    pub tenants: TrackingTenants,
    pub http: OutboundHttp,
    pub events: EntityEventPublisher,
    pub env: Env,
}

/// One tick: every due workspace's due parcels.
pub async fn run_tracking_sweep(sweep: &TrackingSweep, now: OffsetDateTime) -> SweepResult {
    due_index::run_sweep(
        &sweep.master,
        TRACKING_KIND,
        now,
        500,
        Some(Duration::minutes(30)),
        |workspace_id, now| async move { sweep_workspace(sweep, workspace_id, now).await },
    )
    .await
}

async fn sweep_workspace(
    sweep: &TrackingSweep,
    workspace_id: String,
    now: OffsetDateTime,
) -> Result<Option<OffsetDateTime>, String> {
    let (db, clerk_org_id) = (sweep.tenants)(workspace_id.clone()).await?;
    let context = EventContext::new(
        clerk_org_id.unwrap_or_else(|| workspace_id.clone()),
        "system",
        EventSource::System,
    );
    let env = |name: &str| (sweep.env)(name);
    let keyring = weldsuite_connect_domain::connections::keyring(
        env("DATABASE_ENCRYPTION_KEY"),
        env("DATABASE_ENCRYPTION_KEY_V2"),
    );
    let at = utc_timestamp(now);
    let due = parcels::Entity::find()
        .filter(parcels::Column::TrackingNextCheckAt.lte(at))
        .filter(parcels::Column::CarrierCode.is_not_null())
        .filter(parcels::Column::DeletedAt.is_null())
        .order_by_asc(parcels::Column::TrackingNextCheckAt)
        .limit(BATCH)
        .all(&orm(&db))
        .await
        .map_err(|error| error.to_string())?;
    let mut clients: HashMap<String, Option<CarrierClient>> = HashMap::new();
    for row in due {
        let Some(code) = row.carrier_code.as_deref().and_then(CarrierCode::parse) else {
            continue;
        };
        let key = row
            .carrier_id
            .clone()
            .unwrap_or_else(|| code.as_str().to_owned());
        if !clients.contains_key(&key) {
            let client = client_for(&db, &row, code, sweep.http.clone(), &keyring, &env)
                .await
                .map_err(|error| error.to_string())?;
            clients.insert(key.clone(), client);
        }
        let Some(Some(client)) = clients.get(&key) else {
            stop(&db, &row).await.map_err(|error| error.to_string())?;
            continue;
        };
        match poll(&db, client, &row).await {
            Ok(applied) => {
                publish(&context, &sweep.events, &applied);
                if applied.rescanned {
                    charge_rescan(&sweep.master, &workspace_id, &applied.row).await;
                }
            }
            Err(PollError::Carrier(error)) => {
                tracing::warn!(%error, parcel = %row.id, "[stash] tracking failed; backing off");
                back_off(&db, &row, at)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Err(PollError::Database(error)) => return Err(error.to_string()),
        }
    }
    earliest(&db)
        .await
        .map(|next| next.map(PrimitiveDateTime::assume_utc))
        .map_err(|error| error.to_string())
}

async fn stop(db: &PgPool, row: &parcels::Model) -> Result<(), DbErr> {
    parcels::Entity::update_many()
        .col_expr(
            parcels::Column::TrackingNextCheckAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .filter(parcels::Column::Id.eq(row.id.as_str()))
        .exec(&orm(db))
        .await?;
    Ok(())
}

async fn back_off(db: &PgPool, row: &parcels::Model, now: PrimitiveDateTime) -> Result<(), DbErr> {
    parcels::Entity::update_many()
        .col_expr(
            parcels::Column::TrackingNextCheckAt,
            Expr::value(now + Duration::hours(6)),
        )
        .filter(parcels::Column::Id.eq(row.id.as_str()))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// A voided WeldSuite-contract label that was scanned: charge it again.
async fn charge_rescan(master: &PgPool, workspace_id: &str, row: &parcels::Model) {
    let credits = row
        .shipping_cost
        .as_ref()
        .and_then(|cost| cost.get("credits"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if credits <= 0 {
        return;
    }
    let workspace =
        match weldsuite_core_domain::credits::resolve_internal_workspace_id(master, workspace_id)
            .await
        {
            Ok(Some(workspace)) => workspace,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(%error, parcel = %row.id, "[stash] rescan charge: no wallet");
                return;
            }
        };
    billing::charge(
        master,
        &billing::Charge {
            workspace: &workspace,
            credits,
            parcel_id: &row.id,
            idempotency_key: format!("parcel-label-rescan:{}", row.id),
            description: "Voided shipping label used anyway".to_owned(),
            metadata: json!({ "trackingNumber": row.tracking_number, "carrier": row.carrier_code }),
            user_id: None,
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn polling_follows_the_status_and_stops() {
        let created = datetime!(2026-11-20 10:00);
        let now = datetime!(2026-11-21 10:00);
        assert_eq!(
            next_check("label_created", false, created, now, false),
            Some(now + Duration::hours(4))
        );
        assert_eq!(
            next_check("label_created", true, created, now, false),
            Some(now + Duration::days(1))
        );
        assert_eq!(
            next_check("in_transit", false, created, now, false),
            Some(now + Duration::hours(2))
        );
        assert_eq!(
            next_check("at_service_point", false, created, now, false),
            Some(now + Duration::hours(6))
        );
        assert_eq!(next_check("delivered", false, created, now, false), None);
        assert_eq!(next_check("returned", false, created, now, false), None);
        assert_eq!(next_check("cancelled", false, created, now, false), None);
        assert_eq!(
            next_check("cancelled", false, created, now, true),
            Some(now + Duration::hours(12))
        );
        let late = datetime!(2026-12-10 10:00);
        assert_eq!(
            next_check("label_created", false, created, late, false),
            None
        );
        assert!(next_check("label_created", true, created, late, false).is_some());
        assert_eq!(first_check(now, false), Some(now + Duration::hours(4)));
    }
}
