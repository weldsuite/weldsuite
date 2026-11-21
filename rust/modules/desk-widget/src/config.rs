//! `routes/config.ts`: `GET /api/config`, what the widget needs to render:
//! branding, greeting, a few teammate faces, whether the team is in, and
//! where realtime is.

use axum::Extension;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::realtime::now_ms;
use weldsuite_desk_domain::webchat::author_from_member;
use weldsuite_kit::validation::js_trim;

use crate::auth::Widget;
use crate::{Ctx, WidgetState, office_hours, success};

/// A member's user id and `name`.
type Face = (String, Option<String>);

/// Members looked at for the header (`TEAM_CANDIDATES`); the first three with
/// an account picture are shown.
const TEAM_CANDIDATES: i64 = 50;

/// `loadTeam(c)`: up to three active internal teammates, oldest first, whose
/// account has a picture (`master`), by first name. A failure is logged and
/// leaves the team empty.
async fn team(db: &PgPool, master: Option<&PgPool>) -> Vec<Value> {
    let rows: Result<Vec<Face>, sqlx::Error> = sqlx::query_as(
        "select user_id, name from workspace_members
         where upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL'
           and deleted_at is null
         order by created_at asc, id asc
         limit $1",
    )
    .bind(TEAM_CANDIDATES)
    .fetch_all(db)
    .await;
    match rows {
        Ok(rows) => {
            let pictures = weldsuite_db::AccountPictures::load(
                master,
                rows.iter().map(|(user_id, _)| user_id),
            )
            .await;
            rows.into_iter()
                .filter_map(|(user_id, name)| {
                    let picture = pictures.get(&user_id)?;
                    let author = author_from_member(name.as_deref(), Some(picture));
                    Some(json!({ "name": author.name, "avatar": author.avatar }))
                })
                .take(3)
                .collect()
        }
        Err(error) => {
            tracing::error!(%error, "[widget-api] team lookup failed");
            Vec::new()
        }
    }
}

/// `value ?? fallback`.
fn or(value: &Value, fallback: &str) -> Value {
    if value.is_null() {
        json!(fallback)
    } else {
        value.clone()
    }
}

/// `GET /api/config`.
pub(crate) async fn get_config(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
) -> Response {
    let config = &widget.config;
    let branding = &config["branding"];
    let team = team(&widget.db, ctx.master(&state).as_ref()).await;
    let away = config["away_message"]
        .as_str()
        .map(js_trim)
        .filter(|message| !message.is_empty());
    success(
        StatusCode::OK,
        json!({
            "widgetId": config["widget_id"],
            "name": config["widget_name"],
            "enabled": config["enabled"],
            "greeting": or(&config["greeting"], "Hi — how can we help?"),
            "branding": {
                "primaryColor": or(&branding["primaryColor"], "#2563eb"),
                "backgroundColor": or(&branding["backgroundColor"], "#ffffff"),
                "position": or(&branding["position"], "right"),
            },
            "showBranding": !widget.remove_branding,
            "realtimeUrl": ctx.realtime_url(&state),
            "team": team,
            "availability": office_hours::availability(
                &config["office_hours"],
                config["timezone"].as_str(),
                now_ms(),
            ),
            "awayMessage": away,
            "expectedReplyTime": config["expected_reply_time"],
        }),
    )
}
