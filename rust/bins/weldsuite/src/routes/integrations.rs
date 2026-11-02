//! The integration workers (`weldsuite-integrations`): the public webhook
//! receivers at the workers' own paths (`/webhooks/...`), and the service
//! bindings they call, answered in this process. They have no API module
//! id, so they are always served; what they hand to another module goes
//! nowhere while that module is not (WeldBooks' bank feeds until `books`
//! is marked ported), as the worker without the binding.

use std::sync::Arc;

use axum::Router;
use weldsuite_db::{Keyring, PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_integrations::{IntegrationsState, ServiceBinding};

use crate::server::AppState;

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn keyring() -> Keyring {
    Keyring {
        v1: env_value("DATABASE_ENCRYPTION_KEY"),
        v2: env_value("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

/// The receivers, before any authentication.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    weldsuite_integrations::public_router(integrations_state(state))
}

/// The integration workers' handle on the app. Conformance builds take the
/// test's env, master database, KV, HTTP client and bindings per request.
pub(crate) fn integrations_state(state: &AppState) -> IntegrationsState {
    let conformance = cfg!(feature = "conformance");
    let master = state.workspaces.master().clone();
    IntegrationsState {
        events: state.infra.events.clone(),
        master: (!conformance).then(|| master.clone()),
        cache: (!conformance).then(|| state.infra.cache.clone()).flatten(),
        http: (!conformance).then(super::books::books_http).flatten(),
        env: Arc::new(weldsuite_integrations::env_from_process()),
        books: (!conformance)
            .then(|| {
                in_process_books(
                    &master,
                    &keyring(),
                    Arc::clone(&state.workspaces),
                    state.infra.events.clone(),
                )
            })
            .flatten(),
    }
}

/// `BOOKS_INTERNAL`: WeldBooks' internal bank-feed routes in this process,
/// once books is served; none before.
pub(crate) fn in_process_books(
    master: &PgPool,
    keyring: &Keyring,
    workspaces: Arc<Workspaces>,
    events: EntityEventPublisher,
) -> Option<Arc<dyn ServiceBinding>> {
    if !super::mounts("books") {
        return None;
    }
    let tenants: weldsuite_integrations::books::TenantResolver =
        Arc::new(move |reference: String| {
            let workspaces = Arc::clone(&workspaces);
            Box::pin(async move {
                workspaces
                    .tenant(&reference)
                    .await
                    .map_err(|error| error.to_string())
            })
        });
    Some(Arc::new(weldsuite_integrations::books::InProcessBooks {
        tenants,
        keyring: keyring.clone(),
        master: Some(master.clone()),
        env: super::books::books_env(),
        http: super::books::books_http(),
        ponto_http: super::books::ponto_http(),
        events,
    }))
}
