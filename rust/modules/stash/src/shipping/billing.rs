//! Labels on WeldSuite's carrier contract, paid from the workspace's credit
//! wallet (ADR STASH-012): the rate card in master `system_settings`, the
//! check before the carrier is called, the charge after, the refund when
//! labels are voided unscanned.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use weldsuite_core_domain::credits::{
    self, Consumed, CreditsError, GrantKind, LedgerEntry, check_credits, consume_credits_by,
    grant_credits, refund_credits,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_kit::response::CreditShortfall;
use weldsuite_schema::master::system_settings;
use weldsuite_shipping_domain::rates::{RATE_CARD_KEY, RateCard};

use crate::Refusal;

/// The wallet's `service_type` for shipping.
const SERVICE_TYPE: &str = "shipping";

/// The rate card; empty (nothing offered) when none is saved or it can't be
/// read.
pub(crate) async fn rate_card(master: &PgPool) -> Result<RateCard, DbErr> {
    let row = system_settings::Entity::find()
        .filter(system_settings::Column::Key.eq(RATE_CARD_KEY))
        .one(&orm(master))
        .await?;
    let Some(value) = row.and_then(|row| row.value) else {
        return Ok(RateCard::default());
    };
    Ok(RateCard::parse(&value).unwrap_or_else(|error| {
        tracing::warn!(%error, "[stash] the shipping rate card can't be read; nothing is offered");
        RateCard::default()
    }))
}

fn wallet_error(error: &CreditsError) -> Refusal {
    tracing::error!(%error, "[stash] credit wallet");
    ApiError::unavailable("The credit wallet can't be reached").into()
}

/// The workspace's wallet id, after checking it holds `credits`: else the
/// 402 with the shortfall.
pub(crate) async fn ensure_credits(
    master: &PgPool,
    workspace_ref: &str,
    credits: i64,
) -> Result<String, Refusal> {
    let workspace = credits::resolve_internal_workspace_id(master, workspace_ref)
        .await?
        .ok_or_else(|| {
            Refusal::from(ApiError::unavailable("The workspace has no credit wallet"))
        })?;
    if credits <= 0 {
        return Ok(workspace);
    }
    let check = check_credits(master, &workspace, credits)
        .await
        .map_err(|error| wallet_error(&error))?;
    if !check.available {
        #[allow(clippy::cast_precision_loss)]
        let shortfall = CreditShortfall {
            current_balance: Some(check.current_balance as f64),
            required: Some(check.required as f64),
            shortfall: Some(check.shortfall as f64),
        };
        return Err(ApiError::insufficient_credits(Some(shortfall)).into());
    }
    Ok(workspace)
}

/// What a charge records.
pub(crate) struct Charge<'a> {
    pub(crate) workspace: &'a str,
    pub(crate) credits: i64,
    /// The first parcel of the request.
    pub(crate) parcel_id: &'a str,
    pub(crate) idempotency_key: String,
    pub(crate) description: String,
    pub(crate) metadata: Value,
    pub(crate) user_id: Option<&'a str>,
}

/// Take the credits; when a concurrent spend emptied the wallet since the
/// check, book them as debt: the labels exist. Logged, never failing the
/// request (the labels are made).
pub(crate) async fn charge(master: &PgPool, charge: &Charge<'_>) {
    if charge.credits <= 0 {
        return;
    }
    let entry = LedgerEntry {
        workspace_id: charge.workspace,
        amount: charge.credits,
        service_type: Some(SERVICE_TYPE),
        idempotency_key: Some(charge.idempotency_key.clone()),
        reference_id: Some(charge.parcel_id),
        reference_type: Some("parcel"),
        description: Some(charge.description.clone()),
        metadata: Some(charge.metadata.clone()),
    };
    match consume_credits_by(master, &entry, charge.user_id).await {
        Ok(Consumed::Ok { .. }) => {}
        Ok(Consumed::Insufficient { .. }) => {
            let debt = LedgerEntry {
                amount: -charge.credits,
                idempotency_key: Some(format!("{}:debt", charge.idempotency_key)),
                ..entry
            };
            if let Err(error) =
                grant_credits(master, &debt, GrantKind::Adjustment, charge.user_id).await
            {
                tracing::error!(%error, parcel = charge.parcel_id, "[stash] label charge not booked");
            }
        }
        Err(error) => {
            tracing::error!(%error, parcel = charge.parcel_id, "[stash] label charge failed");
        }
    }
}

/// Give the credits of voided, unscanned labels back. Logged on failure.
pub(crate) async fn refund(
    master: &PgPool,
    workspace: &str,
    credits: i64,
    parcel_id: &str,
    idempotency_key: String,
) {
    if credits <= 0 {
        return;
    }
    let entry = LedgerEntry {
        workspace_id: workspace,
        amount: credits,
        service_type: Some(SERVICE_TYPE),
        idempotency_key: Some(idempotency_key),
        reference_id: Some(parcel_id),
        reference_type: Some("parcel"),
        description: Some("Voided shipping labels".to_owned()),
        metadata: None,
    };
    if let Err(error) = refund_credits(master, &entry).await {
        tracing::error!(%error, parcel = parcel_id, "[stash] label refund failed");
    }
}
