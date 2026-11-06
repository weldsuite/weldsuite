//! The GitHub App install flow in WeldMerge (`routes/connections/
//! github-install.ts`, `routes/public/github-setup.ts`,
//! `services/github-install.ts`):
//!
//! ```text
//!   GET /api/merge/connections/github/install-url?returnTo=   → { url }: the App's install page with a signed state
//!   GET /public/merge/github/setup?installation_id&setup_action&state&code
//!       → verifies the state and takes its nonce, proves the installing member can reach the
//!         installation (GitHub's `code`, else their linked GitHub account), reads it with the App
//!         JWT, records it (the master installation index, claimed for this workspace, and the
//!         merge_connections row), publishes merge_connection created/updated and redirects to
//!         `returnTo` (default the providers tab)
//! ```
//!
//! The state is an HS256 JWT (`weldsuite_connect_domain::install_state`),
//! signed with `CLERK_SECRET_KEY` (else `INTERNAL_API_SECRET`), ten
//! minutes: `{workspaceId, userId, returnTo?, nonce}`, good for one redirect
//! (its nonce is kept in `WORKSPACE_CACHE`). The setup route runs before any
//! session: the state decides the workspace, and `installation_id` counts
//! only once a GitHub user token proves it
//! (`weldsuite_connect_domain::github_user`). Its failures redirect back to
//! the providers tab with `error=<code>`.

use axum::extract::{FromRequestParts, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{StatusCode, header};
use serde_json::{Map, Value, json};
use weldsuite_connect_domain::github_app::{AppCredentials, fetch_installation_meta};
use weldsuite_connect_domain::github_user::{
    InstallationAccessEvidence, prove_github_installation_access,
};
use weldsuite_connect_domain::install_state::{
    consume_install_nonce, install_state_nonce, remember_install_nonce, sign_install_state,
    state_secret, verify_install_state,
};
use weldsuite_db::Tenant;
use weldsuite_events::EventContext;
use weldsuite_kit::validation::{Presence, Text, query_values};
use weldsuite_kit::{ApiError, Data};

use crate::db::text;
use crate::github_client::encode_uri_component;
use crate::installations::{
    GithubInstallation, RecordError, record_github_installation, release_github_installation_index,
    set_github_installation_status,
};
use crate::mappers::connection_event_data;
use crate::webhooks::master_of;
use crate::{Answer, Caller, MergeState, Overrides, PendingEvent, publish, validate_query};

/// The platform's origin when `APP_URL` is not set.
const DEFAULT_APP_URL: &str = "https://app.weldsuite.org";
/// `MERGE_GITHUB_INSTALL_DEFAULT_RETURN`.
const DEFAULT_RETURN: &str = "/weldmerge/settings?tab=providers&installed=1";

/// `githubInstallPage(appSlug, state?)`.
pub(crate) fn install_page(app_slug: &str, state: Option<&str>) -> String {
    let base = format!(
        "https://github.com/apps/{}/installations/new",
        encode_uri_component(app_slug)
    );
    match state {
        Some(state) => format!("{base}?state={}", encode_uri_component(state)),
        None => base,
    }
}

/// `sameAppPath(returnTo)`: a same-app relative path (`/…`, not `//host`).
pub(crate) fn same_app_path(return_to: Option<&str>) -> Option<String> {
    let path = return_to.filter(|p| !p.is_empty())?;
    (path.starts_with('/') && !path.starts_with("//") && !path.contains('\\'))
        .then(|| path.to_owned())
}

/// `workspaceAppUrl(baseUrl, clerkOrgId, path)`: inside the workspace
/// (`/w/<org>/…`, FE-013) when its Clerk org id is known.
fn workspace_app_url(base_url: &str, clerk_org_id: Option<&str>, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let inner = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    match clerk_org_id.filter(|org| !org.is_empty()) {
        Some(org) => format!("{base}/w/{}{inner}", encode_uri_component(org)),
        None => format!("{base}{inner}"),
    }
}

fn app_url_or_default(app_url: Option<String>) -> String {
    app_url
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_APP_URL.to_owned())
}

/// `c.redirect(url)`: 302 with the location.
fn redirect(url: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, url.to_owned())]).into_response()
}

/// `GET /connections/github/install-url?returnTo=`.
pub(crate) async fn install_url(
    State(state): State<MergeState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Answer {
    let return_to = validate_query(query.as_deref(), |issues, fields| {
        issues
            .text_with(
                fields,
                "returnTo",
                Presence::Optional,
                Text {
                    max: Some(500),
                    ..Text::default()
                },
            )
            .into_option()
    })?;
    let overrides = &caller.overrides;
    let (Some(slug), Some(cache)) = (
        overrides.env_set(&state, "GITHUB_APP_SLUG"),
        overrides.cache(&state),
    ) else {
        return Err(ApiError::unavailable("GitHub is not configured for WeldMerge").into());
    };
    let mut claims = Map::new();
    claims.insert("workspaceId".into(), json!(caller.workspace_id));
    claims.insert("userId".into(), json!(caller.user_id));
    if let Some(path) = same_app_path(return_to.as_deref()) {
        claims.insert("returnTo".into(), json!(path));
    }
    let nonce = install_state_nonce();
    claims.insert("nonce".into(), json!(nonce));
    let secret = state_secret(
        overrides.env(&state, "CLERK_SECRET_KEY").as_deref(),
        overrides.env(&state, "INTERNAL_API_SECRET").as_deref(),
    );
    let token = sign_install_state(&claims, &secret);
    // The state is good for one setup redirect: it takes the nonce.
    remember_install_nonce(cache.as_ref(), &nonce, &caller.workspace_id)
        .await
        .map_err(|error| ApiError::internal().with_message(error.to_string()))?;
    Ok(Data(json!({ "url": install_page(&slug, Some(&token)) })).into_response())
}

/// What the setup route reads off its request: the tenant when a layer
/// opened it (conformance: the test's), and the overrides.
pub(crate) struct Setup {
    tenant: Option<Tenant>,
    overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Setup {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            tenant: parts.extensions.get::<Tenant>().cloned(),
            overrides: Overrides::from_extensions(&parts.extensions),
        }))
    }
}

/// The setup redirect's query (`mergeGithubSetupQuerySchema`).
struct SetupQuery {
    installation_id: String,
    setup_action: Option<String>,
    state: String,
    /// GitHub's user authorization code, when the App requests it during installation.
    code: Option<String>,
}

/// `mergeGithubSetupQuerySchema`: `installation_id` digits, `state` not
/// empty, `setup_action` and `code` any; the first value of each.
fn setup_query(query: Option<&str>) -> Option<SetupQuery> {
    let values = query_values(query);
    let text = |key: &str| values.get(key).and_then(Value::as_str).map(str::to_owned);
    let installation_id = text("installation_id")
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))?;
    let state = text("state").filter(|s| !s.is_empty())?;
    Some(SetupQuery {
        installation_id,
        setup_action: text("setup_action"),
        state,
        code: text("code"),
    })
}

/// `GET /public/merge/github/setup`.
pub(crate) async fn setup(
    State(state): State<MergeState>,
    setup: Setup,
    RawQuery(query): RawQuery,
) -> Response {
    let overrides = &setup.overrides;
    let app_url = app_url_or_default(overrides.env(&state, "APP_URL"));
    let error_page = |clerk_org_id: Option<&str>, code: &str| {
        redirect(&workspace_app_url(
            &app_url,
            clerk_org_id,
            &format!("/weldmerge/settings?tab=providers&error={code}"),
        ))
    };
    let Some(SetupQuery {
        installation_id,
        setup_action,
        state: token,
        code,
    }) = setup_query(query.as_deref())
    else {
        return error_page(None, "missing_params");
    };
    let secret = state_secret(
        overrides.env(&state, "CLERK_SECRET_KEY").as_deref(),
        overrides.env(&state, "INTERNAL_API_SECRET").as_deref(),
    );
    let Some(claims) = verify_install_state(&token, &secret) else {
        return error_page(None, "invalid_state");
    };
    let claim = |key: &str| claims.get(key).and_then(Value::as_str).map(str::to_owned);
    let workspace_ref = claim("workspaceId").unwrap_or_default();
    let user_id = claim("userId").unwrap_or_default();

    // The state decides the workspace (`getWorkspaceContextForOrg`).
    let tenant = match setup.tenant {
        Some(tenant)
            if tenant.workspace_id == workspace_ref
                || tenant.clerk_org_id.as_deref() == Some(workspace_ref.as_str()) =>
        {
            Some(tenant)
        }
        Some(_) => None,
        None => match &state.tenants {
            Some(tenants) => tenants(workspace_ref.clone()).await.ok(),
            None => None,
        },
    };
    let Some(tenant) = tenant else {
        return error_page(None, "workspace_unavailable");
    };
    let clerk_org_id = tenant.clerk_org_id.clone();
    if tenant.suspended {
        return error_page(clerk_org_id.as_deref(), "workspace_unavailable");
    }
    let fail = |code: &str| error_page(clerk_org_id.as_deref(), code);

    let keyring = overrides.keyring(&state);
    if keyring.is_empty() {
        return fail("configuration_error");
    }
    let (Some(app_id), Some(private_key), Some(cache)) = (
        overrides.env_set(&state, "GITHUB_APP_ID"),
        overrides.env_set(&state, "GITHUB_APP_PRIVATE_KEY"),
        overrides.cache(&state),
    ) else {
        return fail("configuration_error");
    };

    // Events are the installing member's, in this workspace.
    let events = EventContext::from_ids(
        &tenant.workspace_id,
        Some(clerk_org_id.as_deref().unwrap_or(&workspace_ref)),
        &user_id,
    );

    // A state is redeemed once: a replay (or a state never issued) stops here.
    match consume_install_nonce(cache.as_ref(), claim("nonce").as_deref()).await {
        Ok(true) => {}
        Ok(false) => return fail("state_expired"),
        Err(error) => {
            tracing::error!(%error, "merge: GitHub setup failed");
            return fail("internal_error");
        }
    }

    let master = match master_of(&state, overrides) {
        Ok(master) => master,
        Err(error) => {
            tracing::error!(?error, "merge: GitHub setup failed");
            return fail("internal_error");
        }
    };

    if setup_action.as_deref() == Some("delete") {
        let revoked =
            match set_github_installation_status(&tenant.db, &installation_id, "revoked").await {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::error!(%error, "merge: GitHub setup failed");
                    return fail("internal_error");
                }
            };
        // The index row goes only when it names this workspace.
        if let Err(error) =
            release_github_installation_index(&master, &installation_id, &tenant.workspace_id).await
        {
            tracing::error!(%error, "merge: GitHub setup failed");
            return fail("internal_error");
        }
        publish(
            &state,
            &events,
            revoked
                .iter()
                .map(|row| {
                    PendingEvent::new(
                        "merge_connection",
                        "updated",
                        text(row, "id"),
                        connection_event_data(row),
                    )
                })
                .collect(),
        );
        return redirect(&workspace_app_url(
            &app_url,
            clerk_org_id.as_deref(),
            "/weldmerge/settings?tab=providers&disconnected=1",
        ));
    }

    let Some(http) = overrides.outbound(&state) else {
        return fail("internal_error");
    };
    // `memberCanReachInstallation`: GitHub's `code`, else the member's linked
    // GitHub account, must reach the installation the redirect names.
    let client_id = overrides.env_set(&state, "GITHUB_APP_CLIENT_ID");
    let client_secret = overrides.env_set(&state, "GITHUB_APP_CLIENT_SECRET");
    let reachable = prove_github_installation_access(
        &http,
        &installation_id,
        InstallationAccessEvidence {
            code: code.as_deref(),
            client_id: client_id.as_deref(),
            client_secret: client_secret.as_deref(),
        },
        || async {
            crate::credentials::member_token(
                &tenant.db, &state, overrides, &user_id, "github", None,
            )
            .await
            .map(|token| token.map(|token| token.access_token))
            .map_err(|error| format!("{error:?}"))
        },
    )
    .await;
    match reachable {
        Ok(true) => {}
        Ok(false) => return fail("installation_unverified"),
        Err(error) => {
            tracing::error!(error = %weldsuite_kit::log_safe(&error), "merge: GitHub setup failed");
            return fail("internal_error");
        }
    }
    let credentials = AppCredentials {
        app_id,
        private_key,
    };
    let installation = installation_id.parse::<i64>().unwrap_or_default();
    let meta = match fetch_installation_meta(&http, &credentials, installation).await {
        Ok(meta) => meta,
        Err(error) => {
            tracing::error!(error = %weldsuite_kit::log_safe(&error), "merge: GitHub setup failed");
            return fail("internal_error");
        }
    };
    let recorded = record_github_installation(
        &tenant.db,
        &master,
        &keyring,
        &GithubInstallation {
            installation_id,
            app_slug: meta.app_slug,
            account_login: meta.account_login,
            account_type: meta.account_type.to_owned(),
            workspace_id: tenant.workspace_id.clone(),
            user_id,
            scopes: None,
            status: None,
        },
    )
    .await;
    let recorded = match recorded {
        Ok(recorded) => recorded,
        Err(RecordError::Taken(_)) => return fail("installation_taken"),
        Err(error) => {
            tracing::error!(%error, "merge: GitHub setup failed");
            return fail("internal_error");
        }
    };
    publish(
        &state,
        &events,
        vec![PendingEvent::new(
            "merge_connection",
            recorded.action,
            text(&recorded.connection, "id"),
            connection_event_data(&recorded.connection),
        )],
    );
    let path =
        same_app_path(claim("returnTo").as_deref()).unwrap_or_else(|| DEFAULT_RETURN.to_owned());
    redirect(&workspace_app_url(&app_url, clerk_org_id.as_deref(), &path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_same_app_paths_only() {
        assert_eq!(
            same_app_path(Some("/weldmerge/onboarding")).as_deref(),
            Some("/weldmerge/onboarding")
        );
        for bad in [
            "https://evil.example/x",
            "//evil.example",
            "weldmerge/settings",
            "/a\\b",
            "",
        ] {
            assert_eq!(same_app_path(Some(bad)), None, "{bad}");
        }
    }

    #[test]
    fn lands_inside_the_workspace() {
        assert_eq!(
            workspace_app_url("https://app.test/", Some("org_alpha"), "/weldmerge"),
            "https://app.test/w/org_alpha/weldmerge"
        );
        assert_eq!(
            workspace_app_url("https://app.test", None, "weldmerge"),
            "https://app.test/weldmerge"
        );
        assert_eq!(
            install_page("weldsuite merge", None),
            "https://github.com/apps/weldsuite%20merge/installations/new"
        );
    }
}
