//! Integration routes (`routes/integrations/index.ts`), under a form:
//!
//! ```text
//! GET    /forms/:id/integrations                          the form's integrations
//! POST   /forms/:id/integrations                          add one (crm | desk | flow)
//! PATCH  /forms/:id/integrations/:integrationId           switch it on or off, or change its settings
//! DELETE /forms/:id/integrations/:integrationId           remove it (earlier runs stay on their responses)
//! POST   /forms/:id/integrations/:integrationId/test      a dry run against the latest completed response
//! ```
//!
//! Changing an integration needs `forms:update` and the right to edit the
//! form; the steps then act as the member who last changed its settings
//! (ADR FORMS-006). 422 `INVALID_CONFIG` (`details.fields`) when the settings
//! do not fit the form.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    FORM_INTEGRATION_CREATED, FORM_INTEGRATION_DELETED, FORM_INTEGRATION_UPDATED,
};
use weldsuite_catalogs::permission_keys::{FORMS_READ, FORMS_UPDATE};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{Member, load_form};
use crate::FormsState;
use crate::access::Need;
use crate::common::{answer, text};
use crate::input;
use crate::integration_config::{read_crm, read_desk, read_flow};
use crate::integration_test::test_integration;
use crate::integrations::{
    create_integration, delete_integration, get_integration, list_integrations,
    present_integration, update_integration,
};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/forms/{id}/integrations",
            get(list).route_layer(need(FORMS_READ)),
        )
        .route(
            "/forms/{id}/integrations",
            post(create).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/integrations/{integrationId}",
            axum::routing::patch(update)
                .delete(remove)
                .route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/integrations/{integrationId}/test",
            post(dry_run).route_layer(need(FORMS_UPDATE)),
        )
}

/// `{ id, name: kind }` (`supportEventData`).
fn event_data(row: &Value) -> Value {
    json!({ "id": row["id"], "name": row["kind"] })
}

/// `formIntegrationInputSchema`: the kind, `enabled` (default on) and the
/// settings checked by the kind's schema.
struct NewIntegration {
    kind: String,
    enabled: bool,
    config: Value,
}

fn new_integration(issues: &mut Issues, b: &Map<String, Value>) -> Option<NewIntegration> {
    const KINDS: &[&str] = &["crm", "desk", "flow"];
    let Some(kind) = b
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| KINDS.contains(kind))
    else {
        issues.invalid_discriminator("kind", KINDS);
        return None;
    };
    let enabled = issues
        .boolean(b, "enabled", Presence::Optional)
        .into_option()
        .unwrap_or(true);
    issues.nested(
        b,
        "config",
        Presence::Required,
        |issues, config| match kind {
            "crm" => {
                read_crm(issues, config);
            }
            "desk" => {
                read_desk(issues, config);
            }
            _ => {
                read_flow(issues, config);
            }
        },
    );
    Some(NewIntegration {
        kind: kind.to_owned(),
        enabled,
        config: b.get("config").cloned().unwrap_or(Value::Null),
    })
}

/// `updateFormIntegrationSchema`.
fn integration_patch(issues: &mut Issues, b: &Map<String, Value>) -> (Option<bool>, Option<Value>) {
    let enabled = issues
        .boolean(b, "enabled", Presence::Optional)
        .into_option();
    let config = issues
        .nested(b, "config", Presence::Optional, |_, config| {
            Value::Object(config.clone())
        })
        .into_option();
    (enabled, config)
}

async fn list(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, None).await?;
            let rows = list_integrations(&member.ctx, text(&loaded.form, "id")).await?;
            Ok(Data(rows).into_response())
        }
        .await,
    )
}

async fn create(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, new_integration)?;
            let Some(input) = input else {
                return Err(crate::common::Fail::Internal(
                    "forms: an integration read without its kind".to_owned(),
                ));
            };
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            let row = create_integration(
                &member.ctx,
                &loaded.form,
                &member.user_id,
                &input.kind,
                input.enabled,
                &input.config,
            )
            .await?;
            member.publish(
                FORM_INTEGRATION_CREATED,
                text(&row, "id"),
                &event_data(&row),
            );
            Ok(Created(present_integration(&member.ctx, &row).await?).into_response())
        }
        .await,
    )
}

async fn update(
    member: Member,
    Path((id, integration_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (enabled, config) = input::json(&headers, &body, integration_patch)?;
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            let current =
                get_integration(&member.ctx, text(&loaded.form, "id"), &integration_id).await?;
            let row = update_integration(
                &member.ctx,
                &loaded.form,
                &current,
                &member.user_id,
                enabled,
                config.as_ref(),
            )
            .await?;
            member.publish(
                FORM_INTEGRATION_UPDATED,
                text(&row, "id"),
                &event_data(&row),
            );
            Ok(Data(present_integration(&member.ctx, &row).await?).into_response())
        }
        .await,
    )
}

async fn remove(member: Member, Path((id, integration_id)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            let row =
                get_integration(&member.ctx, text(&loaded.form, "id"), &integration_id).await?;
            delete_integration(&member.ctx, &row).await?;
            member.publish(
                FORM_INTEGRATION_DELETED,
                text(&row, "id"),
                &event_data(&row),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

async fn dry_run(member: Member, Path((id, integration_id)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            let row =
                get_integration(&member.ctx, text(&loaded.form, "id"), &integration_id).await?;
            Ok(Data(test_integration(&member.ctx, &row).await?).into_response())
        }
        .await,
    )
}
