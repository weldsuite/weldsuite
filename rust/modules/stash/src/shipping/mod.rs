//! Carrier shipping (ADR STASH-011 to STASH-013; Rust only,
//! `weldsuite-documentation/plans/weldstash-carriers.md`): PostNL and DHL
//! Parcel accounts, labels for a packed pick list, parcels and their
//! tracking.
//!
//! ```text
//! GET    /carriers/catalog                 carriers, their fields, WeldSuite's contract   carriers:read
//! GET    /carriers                         the workspace's carrier accounts               carriers:read
//! POST   /carriers                         connect one (own contract or WeldSuite's)      carriers:create
//! GET    /carriers/:id                     one account                                    carriers:read
//! PATCH  /carriers/:id                     rename, settings, default, new credentials     carriers:update
//! DELETE /carriers/:id                     disconnect                                     carriers:delete
//! POST   /carriers/:id/test                check the credentials                          carriers:read
//! GET    /carriers/:id/products            products to a country                          carriers:read
//! GET    /carriers/:id/service-points      pickup points near a postal code               carriers:read
//! POST   /carriers/:id/quote               the price on WeldSuite's contract              carriers:read
//! GET    /pick-lists/:id/shipping          what the label dialog starts from              parcels:read
//! POST   /pick-lists/:id/labels            labels for a packed pick list                  parcels:create
//! DELETE /pick-lists/:id/labels            void them (before shipping)                    parcels:update
//! GET    /parcels                          parcels, filtered, cursor-paged                parcels:read
//! GET    /parcels/:id                      one parcel with its tracking events            parcels:read
//! GET    /parcels/:id/label                the label file                                 parcels:read
//! GET    /parcels/:id/customs-document     the CN23 / invoice                             parcels:read
//! POST   /parcels/:id/refresh-tracking     poll the carrier now                           parcels:update
//! POST   /parcels/:id/return-label         a return label for a sent parcel               parcels:create
//! ```
//!
//! Accounts are `carriers` rows ([`accounts`]); labels and their parcels are
//! made in [`labels`]; [`tracking`] follows them (the `stash_parcel_tracking`
//! due index and its sweep); [`billing`] charges WeldSuite's contract to the
//! credit wallet.

pub(crate) mod accounts;
mod addresses;
pub(crate) mod billing;
pub(crate) mod labels;
pub(crate) mod parcels;
pub mod tracking;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use weldsuite_db::{Keyring, MasterDb, PgPool, Tenant};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::json_body;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynFileStore;
use weldsuite_shipping_domain::CarrierError;

use crate::{Caller, Refusal, StashState};

pub use tracking::{TRACKING_KIND, TrackingSweep, run_tracking_sweep};

/// What carrier shipping needs beyond [`StashState`]: the master database
/// (the credit wallet, the rate card, the tracking due index) and the
/// private file store (labels). The binary adds it to the stash router as a
/// request extension; without the store, making labels answers 503.
#[derive(Clone, Default)]
pub struct Services {
    pub master: Option<PgPool>,
    pub files: Option<Arc<dyn DynFileStore>>,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services")
            .field("master", &self.master.is_some())
            .field("files", &self.files.is_some())
            .finish()
    }
}

/// A shipping request: the stash [`Caller`], the workspace's
/// `workspaces.id` and the [`Services`].
pub(crate) struct Ctx {
    pub(crate) caller: Caller,
    pub(crate) workspace_id: String,
    pub(crate) master: Option<PgPool>,
    pub(crate) files: Option<Arc<dyn DynFileStore>>,
}

impl<S: Send + Sync> FromRequestParts<S> for Ctx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let caller = Caller::from_request_parts(parts, state).await?;
        let workspace_id = parts
            .extensions
            .get::<Tenant>()
            .map(|tenant| tenant.workspace_id.clone())
            .unwrap_or_default();
        let services = parts
            .extensions
            .get::<Services>()
            .cloned()
            .unwrap_or_default();
        let master = parts
            .extensions
            .get::<MasterDb>()
            .map(|master| master.0.clone())
            .or(services.master);
        Ok(Self {
            caller,
            workspace_id,
            master,
            files: services.files,
        })
    }
}

impl Ctx {
    /// The workspace keyring that seals carrier credentials.
    pub(crate) fn keyring(&self) -> Keyring {
        weldsuite_connect_domain::connections::keyring(
            self.caller.env("DATABASE_ENCRYPTION_KEY"),
            self.caller.env("DATABASE_ENCRYPTION_KEY_V2"),
        )
    }

    /// The private store's key for a parcel's file.
    pub(crate) fn file_key(&self, parcel_id: &str, name: &str) -> String {
        format!(
            "workspaces/{}/stash/parcels/{parcel_id}/{name}",
            self.workspace_id
        )
    }
}

/// The routes under `/carriers` and `/parcels`; [`labels::routes`] adds the
/// pick-list routes.
pub(crate) fn carrier_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    accounts::routes(gate)
}

pub(crate) fn parcel_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    parcels::routes(gate)
}

/// A JSON body read into `T`, or the 400.
pub(crate) fn read_body<T: DeserializeOwned + Default>(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<T, Refusal> {
    if body.is_empty() {
        return Ok(T::default());
    }
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let value = json_body(content_type, body).map_err(|bad| {
        Refusal::Response(Box::new(axum::response::IntoResponse::into_response(bad)))
    })?;
    serde_json::from_value(value).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            format!("Invalid request body: {error}"),
        )
        .into()
    })
}

/// A carrier's refusal as the API answers it: 400 with the carrier's code
/// and messages, 502 when the carrier failed.
pub(crate) fn carrier_refusal(error: &CarrierError) -> Refusal {
    let status = match error {
        CarrierError::Unavailable(_) => StatusCode::BAD_GATEWAY,
        _ => StatusCode::BAD_REQUEST,
    };
    let messages: Vec<String> = match error {
        CarrierError::Rejected(messages) => messages.clone(),
        other => vec![other.message()],
    };
    ApiError::new(status, error.code(), error.message())
        .with_details(json!({ "messages": messages }))
        .into()
}

/// A JSON field as trimmed text, or `None` when absent or blank.
pub(crate) fn field(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}
