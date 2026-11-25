//! `PUT /api/projects/:id/delivery` (EU and self-hosted only, ADR
//! FLOW-023): how the project delivers its work. The approach (task list,
//! predictive, Scrum, Kanban or hybrid), the sprint length, the work item
//! types it uses, WIP limits per stage and the definition of done. Written
//! whole, defaults filled in, into `settings.delivery`; the rules live in
//! [`weldsuite_flow_domain::agile`].
//!
//! The checks run in the order of the project's other settings: permission,
//! then the project (404), then manage access (403), then the body (400).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::PROJECT_UPDATED;
use weldsuite_db::{orm, utc_now};
use weldsuite_flow_domain::agile::read_delivery;
use weldsuite_kit::Data;
use weldsuite_schema::tenant::projects;

use crate::project_schedule::{PROJECT_MANAGE_DENIED, find_live_project};
use crate::project_tabs::merged_settings;
use crate::raid_body::parse_body;
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

pub(crate) async fn put_delivery(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let delivery = parse_body(&body, read_delivery)?;
        Ok((project, delivery))
    }
    .await;
    let (project, delivery) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_delivery(&state, &caller, &project_id, &project, delivery).await,
        "Failed to update the delivery settings",
    )
}

async fn write_delivery(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    project: &Value,
    delivery: Value,
) -> Reply {
    // A merge of this key only: the other settings keys are other features'.
    projects::Entity::update_many()
        .col_expr(
            projects::Column::Settings,
            merged_settings(json!({ "delivery": delivery.clone() })),
        )
        .col_expr(projects::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(projects::Column::Id.eq(project_id))
        .exec(&orm(&caller.db))
        .await?;
    if let Value::Object(map) = project {
        caller.publish(
            state,
            PROJECT_UPDATED,
            project_id,
            &crate::projects::analytics_payload(map),
        );
    }
    Ok(Data(delivery).into_response())
}
