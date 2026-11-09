//! The routes: the member side at `/api/forms` (this file and [`fill`]) and
//! the respondent side at `/public/forms` ([`public`]). Paths, status codes,
//! error codes and bodies are forms-api's (`apps/workers/forms-api/src/routes/`).

mod ai;
mod cross;
mod fill;
mod integrations;
mod invitations;
mod public;
mod responses;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{
    DefaultBodyLimit, FromRequest, FromRequestParts, Multipart, Path, RawQuery, Request,
};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use http::HeaderMap;
use http::request::Parts;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::{
    EventName, FORM_CLOSED, FORM_CREATED, FORM_DELETED, FORM_FOLDER_CREATED, FORM_FOLDER_DELETED,
    FORM_FOLDER_UPDATED, FORM_PUBLISHED, FORM_THEME_CREATED, FORM_THEME_DELETED,
    FORM_THEME_UPDATED, FORM_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    FORMS_CREATE, FORMS_DELETE, FORMS_MANAGE, FORMS_PUBLISH, FORMS_READ, FORMS_UPDATE,
};
use weldsuite_db::Tenant;
use weldsuite_events::{EventContext, publish_entity_event};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

pub use self::public::{FORMS_PORTAL_KEY_HEADER, RESPONDENT_IP_HEADER, public_router};
use crate::FormsState;
use crate::access::{AccessibleForm, Grants, Need, load_accessible_form, resolve_grants};
use crate::common::{Ctx, FormsResult, answer, forms_error, text};
use crate::folders_themes as ft;
use crate::forms::{
    create_form, delete_form, detail_of, duplicate_form, form_event_data, list_access, list_forms,
    load_row, set_access, update_form,
};
use crate::input;
use crate::publishing::{
    close_form, discard_changes, get_version, list_versions, publish_form, reopen_form,
};
use crate::usage::load_usage;
use crate::workspace;

/// A member of the workspace calling a route: the context, who they are and
/// what they hold.
pub(crate) struct Member {
    pub(crate) ctx: Ctx,
    pub(crate) user_id: String,
    /// `None` on the fill page, which has no permission layer.
    pub(crate) permissions: Option<Permissions>,
    pub(crate) events: EventContext,
}

impl Member {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(&self, event: EventName, entity_id: &str, data: &Value) {
        publish_entity_event(&self.ctx.svc.events, &self.events, event, entity_id, data);
    }

    pub(crate) fn grants(&self) -> Grants {
        self.permissions
            .as_ref()
            .map(resolve_grants)
            .unwrap_or_default()
    }
}

/// Behind the session, tenant database and permission layers; without them
/// it is a routing mistake (500).
impl FromRequestParts<FormsState> for Member {
    type Rejection = Response;

    fn from_request_parts(
        parts: &mut Parts,
        state: &FormsState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let permissions = parts.extensions.get::<Permissions>();
        let member = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                ctx: Ctx {
                    db: tenant.db.clone(),
                    master: state.master(&parts.extensions),
                    workspace_id: tenant.workspace_id.clone(),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .unwrap_or_else(|| tenant.workspace_id.clone()),
                    svc: state.services(&parts.extensions),
                },
                user_id: auth.user_id.clone(),
                permissions: permissions.cloned(),
                events: EventContext::for_request(auth, tenant),
            })
        } else {
            tracing::error!("forms: a route without the session or tenant layer");
            Err(ApiError::internal().into_response())
        };
        std::future::ready(member)
    }
}

/// `/api/forms`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission`.
pub fn router<S, Q>(state: FormsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/forms", get(list).route_layer(need(FORMS_READ)))
        .route("/forms", post(create).route_layer(need(FORMS_CREATE)))
        .route("/forms/{id}", get(detail).route_layer(need(FORMS_READ)))
        .route("/forms/{id}", patch(update).route_layer(need(FORMS_UPDATE)))
        .route(
            "/forms/{id}",
            axum::routing::delete(remove).route_layer(need(FORMS_DELETE)),
        )
        .route(
            "/forms/{id}/duplicate",
            post(duplicate).route_layer(need(FORMS_CREATE)),
        )
        .route(
            "/forms/{id}/publish",
            post(publish).route_layer(need(FORMS_PUBLISH)),
        )
        .route(
            "/forms/{id}/close",
            post(close).route_layer(need(FORMS_PUBLISH)),
        )
        .route(
            "/forms/{id}/reopen",
            post(reopen).route_layer(need(FORMS_PUBLISH)),
        )
        .route(
            "/forms/{id}/discard",
            post(discard).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/versions",
            get(versions).route_layer(need(FORMS_READ)),
        )
        .route(
            "/forms/{id}/versions/{versionId}",
            get(version).route_layer(need(FORMS_READ)),
        )
        .route(
            "/forms/{id}/access",
            get(access).route_layer(need(FORMS_READ)),
        )
        .route(
            "/forms/{id}/access",
            put(replace_access).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/subscription",
            get(subscription)
                .put(set_subscription)
                .route_layer(need(FORMS_READ)),
        )
        .route("/folders", get(folders).route_layer(need(FORMS_READ)))
        .route(
            "/folders",
            post(create_folder).route_layer(need(FORMS_CREATE)),
        )
        .route(
            "/folders/{id}",
            patch(update_folder).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/folders/{id}",
            axum::routing::delete(delete_folder).route_layer(need(FORMS_DELETE)),
        )
        .route("/themes", get(themes).route_layer(need(FORMS_READ)))
        .route(
            "/themes",
            post(create_theme).route_layer(need(FORMS_MANAGE)),
        )
        .route(
            "/themes/{id}",
            patch(update_theme)
                .delete(delete_theme)
                .route_layer(need(FORMS_MANAGE)),
        )
        .route("/settings", get(settings).route_layer(need(FORMS_READ)))
        .route(
            "/settings",
            patch(update_settings).route_layer(need(FORMS_MANAGE)),
        )
        .route("/usage", get(usage).route_layer(need(FORMS_READ)))
        .route(
            "/media",
            post(media)
                .route_layer(need(FORMS_UPDATE))
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .merge(responses::routes(gate))
        .merge(cross::routes(gate))
        .merge(invitations::routes(gate))
        .merge(integrations::routes(gate))
        .merge(ai::routes(gate))
        .merge(fill::routes())
        .with_state(state)
}

// ── Forms ────────────────────────────────────────────────────────────────────

/// `loadForm(c, id, need)`: 404 when it does not exist or is restricted and
/// the member is not on it; 403 when `need` is not theirs.
pub(crate) async fn load_form(
    member: &Member,
    id: &str,
    need: Option<Need>,
) -> FormsResult<AccessibleForm> {
    let loaded =
        load_accessible_form(&member.ctx.db, id, &member.user_id, &member.grants()).await?;
    if let Some(need) = need
        && !loaded.permissions.allows(need)
    {
        return Err(forms_error(
            403,
            "FORBIDDEN",
            "You do not have access to do this on this form.",
        ));
    }
    Ok(loaded)
}

async fn detail_for(member: &Member, loaded: &AccessibleForm, row: &Value) -> FormsResult<Value> {
    detail_of(&member.ctx, row, loaded.relation, &member.grants()).await
}

async fn list(member: Member, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let query = input::query(query.as_deref(), input::list_forms)?;
            let (rows, total, next) =
                list_forms(&member.ctx, &member.user_id, &member.grants(), &query).await?;
            Ok(List::new(
                rows,
                Pagination::new(u64::try_from(total).unwrap_or(0), next.is_some(), next),
            )
            .into_response())
        }
        .await,
    )
}

async fn create(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::create_form)?;
            let form = create_form(&member.ctx, &member.user_id, &input).await?;
            member.publish(FORM_CREATED, text(&form, "id"), &form_event_data(&form));
            let loaded = load_form(&member, text(&form, "id"), None).await?;
            Ok(Created(detail_for(&member, &loaded, &form).await?).into_response())
        }
        .await,
    )
}

async fn detail(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, None).await?;
            Ok(Data(detail_for(&member, &loaded, &loaded.form).await?).into_response())
        }
        .await,
    )
}

async fn update(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::update_form)?;
            let loaded = load_form(&member, &id, Some(Need::Edit)).await?;
            if input.access.is_some() && !loaded.permissions.manage_access {
                return Err(forms_error(
                    403,
                    "FORBIDDEN",
                    "Only the owner can change who can see this form.",
                ));
            }
            let form = update_form(&member.ctx, &loaded.form, &input).await?;
            member.publish(FORM_UPDATED, text(&form, "id"), &form_event_data(&form));
            Ok(Data(detail_for(&member, &loaded, &form).await?).into_response())
        }
        .await,
    )
}

async fn remove(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Delete)).await?;
            let keys = delete_form(&member.ctx, &loaded.form).await?;
            // The files are gone from the database already: their objects go best effort.
            if !keys.is_empty()
                && let Some(files) = member.ctx.svc.files.clone()
            {
                member.ctx.after(async move {
                    for chunk in keys.chunks(1000) {
                        if let Err(error) = files.private.delete_many_boxed(chunk).await {
                            tracing::warn!(%error, "forms: deleting a deleted form's files failed");
                        }
                    }
                });
            }
            member.publish(
                FORM_DELETED,
                text(&loaded.form, "id"),
                &form_event_data(&loaded.form),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

async fn duplicate(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let title = input::json(&headers, &body, input::duplicate_form)?;
            let loaded = load_form(&member, &id, None).await?;
            let copy = duplicate_form(&member.ctx, &loaded.form, &member.user_id, title.as_deref())
                .await?;
            member.publish(FORM_CREATED, text(&copy, "id"), &form_event_data(&copy));
            let copied = load_form(&member, text(&copy, "id"), None).await?;
            Ok(Created(detail_for(&member, &copied, &copy).await?).into_response())
        }
        .await,
    )
}

async fn publish(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Publish)).await?;
            let (form, version) = publish_form(&member.ctx, &loaded.form, &member.user_id).await?;
            let mut data = form_event_data(&form);
            data["version"] = version["number"].clone();
            member.publish(FORM_PUBLISHED, text(&form, "id"), &data);
            let detail = detail_for(&member, &loaded, &form).await?;
            Ok(Data(json!({ "form": detail, "version": version })).into_response())
        }
        .await,
    )
}

async fn lifecycle(
    member: Member,
    id: String,
    need: Need,
    event: EventName,
    run: impl AsyncFnOnce(&Ctx, &Value) -> FormsResult<Value>,
) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(need)).await?;
            let form = run(&member.ctx, &loaded.form).await?;
            member.publish(event, text(&form, "id"), &form_event_data(&form));
            Ok(Data(detail_for(&member, &loaded, &form).await?).into_response())
        }
        .await,
    )
}

async fn close(member: Member, Path(id): Path<String>) -> Response {
    lifecycle(member, id, Need::Publish, FORM_CLOSED, close_form).await
}

async fn reopen(member: Member, Path(id): Path<String>) -> Response {
    lifecycle(member, id, Need::Publish, FORM_UPDATED, reopen_form).await
}

async fn discard(member: Member, Path(id): Path<String>) -> Response {
    lifecycle(member, id, Need::Edit, FORM_UPDATED, discard_changes).await
}

async fn versions(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, None).await?;
            Ok(Data(list_versions(&member.ctx, text(&loaded.form, "id")).await?).into_response())
        }
        .await,
    )
}

async fn version(member: Member, Path((id, version_id)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, None).await?;
            Ok(
                Data(get_version(&member.ctx, text(&loaded.form, "id"), &version_id).await?)
                    .into_response(),
            )
        }
        .await,
    )
}

async fn access(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::ManageAccess)).await?;
            Ok(Data(list_access(&member.ctx, text(&loaded.form, "id")).await?).into_response())
        }
        .await,
    )
}

async fn replace_access(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let entries = input::json(&headers, &body, input::set_access)?;
            let loaded = load_form(&member, &id, Some(Need::ManageAccess)).await?;
            let listed = set_access(&member.ctx, &loaded.form, &entries).await?;
            member.publish(
                FORM_UPDATED,
                text(&loaded.form, "id"),
                &form_event_data(&loaded.form),
            );
            Ok(Data(listed).into_response())
        }
        .await,
    )
}

async fn subscription(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, None).await?;
            let mode =
                workspace::get_subscription(&member.ctx, text(&loaded.form, "id"), &member.user_id)
                    .await?;
            Ok(Data(mode).into_response())
        }
        .await,
    )
}

async fn set_subscription(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let mode = input::json(&headers, &body, input::subscription)?;
            let loaded = load_form(&member, &id, None).await?;
            let set = workspace::set_subscription(
                &member.ctx,
                text(&loaded.form, "id"),
                &member.user_id,
                &mode,
            )
            .await?;
            Ok(Data(set).into_response())
        }
        .await,
    )
}

// ── Folders ──────────────────────────────────────────────────────────────────

fn support_event_data(row: &Value) -> Value {
    json!({ "id": row["id"], "name": row["name"] })
}

async fn folders(member: Member) -> Response {
    answer(async { Ok(Data(ft::list_folders(&member.ctx).await?).into_response()) }.await)
}

async fn create_folder(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let name = input::json(&headers, &body, input::create_folder)?;
            let folder = ft::create_folder(&member.ctx, &name).await?;
            member.publish(
                FORM_FOLDER_CREATED,
                text(&folder, "id"),
                &support_event_data(&folder),
            );
            Ok(Created(folder).into_response())
        }
        .await,
    )
}

async fn update_folder(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, position) = input::json(&headers, &body, input::update_folder)?;
            let row = ft::load_folder(&member.ctx, &id).await?;
            let folder = ft::update_folder(&member.ctx, &row, name.as_deref(), position).await?;
            member.publish(
                FORM_FOLDER_UPDATED,
                text(&folder, "id"),
                &support_event_data(&folder),
            );
            Ok(Data(folder).into_response())
        }
        .await,
    )
}

async fn delete_folder(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let folder = ft::load_folder(&member.ctx, &id).await?;
            ft::delete_folder(&member.ctx, &folder).await?;
            member.publish(
                FORM_FOLDER_DELETED,
                text(&folder, "id"),
                &support_event_data(&folder),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Themes ───────────────────────────────────────────────────────────────────

async fn themes(member: Member) -> Response {
    answer(async { Ok(Data(ft::list_themes(&member.ctx).await?).into_response()) }.await)
}

async fn create_theme(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let theme = input::json(&headers, &body, |issues, b| input::theme(issues, b, false))?;
            let created = ft::create_theme(
                &member.ctx,
                &member.user_id,
                theme.name.as_deref().unwrap_or_default(),
                theme.tokens.as_ref().unwrap_or(&Value::Null),
                theme.is_default,
            )
            .await?;
            member.publish(
                FORM_THEME_CREATED,
                text(&created, "id"),
                &support_event_data(&created),
            );
            Ok(Created(created).into_response())
        }
        .await,
    )
}

async fn update_theme(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, |issues, b| input::theme(issues, b, true))?;
            let row = ft::load_theme(&member.ctx, &id).await?;
            let theme = ft::update_theme(
                &member.ctx,
                &row,
                input.name.as_deref(),
                input.tokens.as_ref(),
                input.is_default,
            )
            .await?;
            member.publish(
                FORM_THEME_UPDATED,
                text(&theme, "id"),
                &support_event_data(&theme),
            );
            Ok(Data(theme).into_response())
        }
        .await,
    )
}

async fn delete_theme(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let theme = ft::load_theme(&member.ctx, &id).await?;
            ft::delete_theme(&member.ctx, &theme).await?;
            member.publish(
                FORM_THEME_DELETED,
                text(&theme, "id"),
                &support_event_data(&theme),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Settings, usage, media ───────────────────────────────────────────────────

async fn settings(member: Member) -> Response {
    answer(
        async { Ok(Data(workspace::get_workspace_settings(&member.ctx).await?).into_response()) }
            .await,
    )
}

async fn update_settings(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let patch = input::json(&headers, &body, input::workspace_settings)?;
            Ok(
                Data(workspace::update_workspace_settings(&member.ctx, &patch).await?)
                    .into_response(),
            )
        }
        .await,
    )
}

async fn usage(member: Member) -> Response {
    answer(
        async {
            let usage = load_usage(&member.ctx, member.ctx.now_ms()).await?;
            Ok(Data(usage.to_json()).into_response())
        }
        .await,
    )
}

/// A multipart body's fields: `(name, file name, content type, bytes)`;
/// `None` when the body is not multipart form data.
pub(crate) async fn multipart_fields(
    request: Request,
) -> Option<Vec<(String, Option<String>, String, Vec<u8>)>> {
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut fields = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or_default().to_owned();
                let file_name = field.file_name().map(str::to_owned);
                let content_type = field.content_type().unwrap_or_default().to_owned();
                let bytes = field.bytes().await.ok()?;
                fields.push((name, file_name, content_type, bytes.to_vec()));
            }
            Ok(None) => return Some(fields),
            Err(_) => return None,
        }
    }
}

async fn media(member: Member, request: Request) -> Response {
    answer(
        async {
            let Some(fields) = multipart_fields(request).await else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send the image as multipart form data in the \"file\" field.",
                ));
            };
            let Some((_, _, content_type, bytes)) = fields
                .into_iter()
                .find(|(name, _, _, _)| name == "file")
                .filter(|(_, file_name, _, _)| file_name.is_some())
            else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send the image in the \"file\" field.",
                ));
            };
            let uploaded = workspace::upload_media(&member.ctx, &content_type, bytes).await?;
            Ok(Created(uploaded).into_response())
        }
        .await,
    )
}

/// The `load_row` of the routes (a form by id).
#[allow(dead_code)]
pub(crate) async fn form_by_id(ctx: &Ctx, id: &str) -> FormsResult<Value> {
    load_row(ctx, id).await
}
