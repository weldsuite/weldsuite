//! `/api/crm-settings`: WeldCRM's workspace settings. Rust only (the EU and
//! self-hosted editions): Global's crm-api has no such route, and the
//! platform hides the tab there (`crm-auto-add` in
//! `GLOBAL_UNAVAILABLE_FEATURES`).
//!
//! Today they are auto-add ([`weldsuite_crm_domain::auto_add`]):
//! `{ autoAdd: { enabled, createCompanies, sources: { email, meetings,
//! helpdesk } } }`. A PUT changes only the keys it gives.

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::CRM_SETTINGS_UPDATED;
use weldsuite_crm_domain::auto_add::{self, Patch, Settings};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{Data, generate_id};

use crate::{Caller, CrmState, answer, validate};

const LOG: &str = "crm-settings";

fn view(settings: &Settings) -> Value {
    json!({ "autoAdd": settings.to_json() })
}

/// The PUT body's `autoAdd`; a body without it changes nothing.
fn patch_of(issues: &mut Issues, fields: &serde_json::Map<String, Value>) -> Patch {
    issues
        .nested(fields, "autoAdd", Presence::Optional, |issues, auto_add| {
            let flag = |issues: &mut Issues, key: &str| {
                issues
                    .boolean(auto_add, key, Presence::Optional)
                    .into_option()
            };
            let enabled = flag(issues, "enabled");
            let create_companies = flag(issues, "createCompanies");
            let sources = issues
                .nested(
                    auto_add,
                    "sources",
                    Presence::Optional,
                    |issues, sources| {
                        let source = |issues: &mut Issues, key: &str| {
                            issues
                                .boolean(sources, key, Presence::Optional)
                                .into_option()
                        };
                        (
                            source(issues, "email"),
                            source(issues, "meetings"),
                            source(issues, "helpdesk"),
                        )
                    },
                )
                .into_option()
                .unwrap_or_default();
            Patch {
                enabled,
                create_companies,
                email: sources.0,
                meetings: sources.1,
                helpdesk: sources.2,
            }
        })
        .into_option()
        .unwrap_or_default()
}

/// `GET /api/crm-settings`.
pub(crate) async fn read(caller: Caller) -> Response {
    let result = async {
        let settings = auto_add::load_settings(&caller.db).await?;
        Ok(Data(view(&settings)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch CRM settings")
}

/// `PUT /api/crm-settings`: the settings after the change.
pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let patch = validate(&headers, &body, patch_of)?;
        let (settings, row_id) =
            auto_add::save_settings(&caller.db, &patch, &generate_id("ws")).await?;
        let data = view(&settings);
        caller.publish(&state, CRM_SETTINGS_UPDATED, &row_id, &data);
        Ok(Data(data).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update CRM settings")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_patch(body: &Value) -> Result<Patch, ()> {
        let mut issues = Issues::default();
        let patch = issues
            .object(body)
            .map(|fields| patch_of(&mut issues, fields));
        issues.finish().map_err(|_| ())?;
        patch.ok_or(())
    }

    #[test]
    fn a_patch_takes_only_the_keys_given() {
        assert_eq!(read_patch(&json!({})), Ok(Patch::default()));
        assert_eq!(
            read_patch(
                &json!({ "autoAdd": { "enabled": true, "sources": { "helpdesk": false } } })
            ),
            Ok(Patch {
                enabled: Some(true),
                helpdesk: Some(false),
                ..Patch::default()
            })
        );
    }

    #[test]
    fn a_patch_refuses_what_is_not_a_boolean() {
        assert!(read_patch(&json!({ "autoAdd": { "enabled": "yes" } })).is_err());
        assert!(read_patch(&json!({ "autoAdd": { "sources": { "email": 1 } } })).is_err());
        assert!(read_patch(&json!({ "autoAdd": true })).is_err());
    }
}
