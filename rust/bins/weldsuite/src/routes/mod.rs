//! The ported `/api` routes, by object, as the workers organise them. Paths,
//! bodies, status codes and messages are the TypeScript routes'; the
//! conformance suite (`rust/conformance/suites.json`) runs their tests here.
//!
//! Core routes live in this crate; a ported `weld*` module is its own crate
//! under `rust/modules/` and is mounted at its path prefix.

mod access_requests;
mod books;
mod feature_flags;
mod me;

use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::routing::{get, patch, post};
use weldsuite_ports::{DynCache, MemoryCache};

use crate::server::AppState;

/// Every ported route, relative to `/api`.
#[allow(clippy::too_many_lines)] // one block per mounted module or core area
pub(crate) fn api(state: &AppState) -> Router<AppState> {
    let router = Router::new()
        .route("/me/permissions", get(me::permissions))
        .route("/feature-flags", get(feature_flags::list))
        .route("/access-requests", post(access_requests::create))
        .route(
            "/access-requests/me/pending",
            get(access_requests::my_pending),
        )
        .route(
            "/access-requests/{id}",
            patch(access_requests::resolve).route_layer(state.permissions.require(["team:update"])),
        );
    // Core: WeldObjects, custom fields, object templates and grid views
    // (P4, sub-phase 4e). Served wherever core is marked ported, like every
    // core area below.
    let router = if mounts("core") {
        let objects = weldsuite_core_objects::CoreObjectsState {
            events: state.infra.events.clone(),
        };
        let gate = &state.permissions;
        router
            .nest(
                "/custom-objects",
                weldsuite_core_objects::custom_objects_router(objects.clone(), gate),
            )
            .nest(
                "/objects",
                weldsuite_core_objects::objects_router(objects.clone(), gate),
            )
            .nest(
                "/related",
                weldsuite_core_objects::related_router(objects.clone(), gate),
            )
            .nest(
                "/custom-fields",
                weldsuite_core_objects::custom_fields_router(objects.clone(), gate),
            )
            .nest(
                "/object-templates",
                weldsuite_core_objects::object_templates_router(objects.clone(), gate),
            )
            .nest(
                "/grid-views",
                weldsuite_core_objects::grid_views_router(objects, gate),
            )
    } else {
        router
    };
    let router = core_team(router, state);
    let router = core_platform(router, state);
    let router = core_apps(router, state);
    let router = if mounts("know") {
        let know = weldsuite_know::KnowState {
            events: state.infra.events.clone(),
        };
        router.nest(
            "/knowledge",
            weldsuite_know::router(know, &state.permissions),
        )
    } else {
        router
    };
    let router = if mounts("sign") {
        let sign = sign_state(state);
        // The finalize job runs where the jobs adapter calls it: in this
        // process, or from Restate through this pod's jobs endpoint.
        state
            .infra
            .job_registry
            .register(weldsuite_sign::FinalizeJob {
                tenants: Arc::new(crate::cron::WorkspaceTenants(Arc::clone(&state.workspaces))),
                master: state.workspaces.master().clone(),
                services: sign.services(),
            });
        router.nest("/sign", weldsuite_sign::router(sign, &state.permissions))
    } else {
        router
    };
    let router = crm(router, state);
    let router = commerce(router, state);
    let router = connect(router, state);
    let router = ads(router, state);
    let router = social(router, state);
    let router = data(router, state);
    let router = calendar(router, state);
    let router = chat(router, state);
    let router = desk(router, state);
    let router = flow(router, state);
    let router = stash(router, state);
    let router = books::api(router, state);
    let router = if mounts("pass") {
        router.nest(
            "/weldpass",
            weldsuite_pass::router(pass_state(), &state.permissions),
        )
    } else {
        router
    };
    let router = if mounts("mail") {
        // Scheduled sends: the delayed delivery job (SendScheduledEmailWorkflow).
        state
            .infra
            .job_registry
            .register(weldsuite_mail::scheduled::SendScheduledEmailJob {
                state: mail_state(state),
                tenants: mail_tenants(state),
            });
        router.merge(weldsuite_mail::router(
            mail_state(state),
            &state.permissions,
        ))
    } else {
        router
    };
    core_files(router, state)
}

/// WeldStash (`weldsuite-stash`): stash-api's routes at their own prefixes
/// (`/warehouses`, `/inventory`, `/pick-lists`, …), once the module is marked
/// ported (always in conformance builds).
fn stash(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("stash") {
        return router;
    }
    let stash = weldsuite_stash::StashState {
        events: state.infra.events.clone(),
        // Sendcloud; conformance builds take the test's bridge per request.
        http: (!cfg!(feature = "conformance"))
            .then(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(15))
                    .ok()
            })
            .flatten()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client))),
    };
    router.merge(weldsuite_stash::router(stash, &state.permissions))
}

/// WeldCRM (`weldsuite-crm`): crm-api's routes at their own prefixes
/// (`/companies`, `/leads`, …), once the module is marked ported.
fn crm(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("crm") {
        return router;
    }
    let services = weldsuite_crm::CrmServices {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        files: file_stores(state),
        cache: state.infra.cache.clone(),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        env: Arc::new(weldsuite_crm::env_from_process()),
    };
    // Sequence runs, where the jobs adapter calls them. Customer mail goes
    // through WeldMail's relay and ledgers ([`mail_outbound`], MAIL-010);
    // without `MAIL_SMTP_URL` a send step fails as crm-api does without
    // `SEND_EMAIL`.
    state
        .infra
        .job_registry
        .register(weldsuite_crm::ExecuteSequenceJob {
            tenants: tenant_databases(state),
            outbound: deployment_outbound(state),
            master: Some(state.workspaces.master().clone()),
            cache: state.infra.cache.clone(),
            realtime: state.infra.realtime.clone(),
        });
    router.merge(weldsuite_crm::router(
        weldsuite_crm::CrmState {
            services,
            // chat-api's record chats once the chat module is mounted: a
            // binding that runs the request through this server's router.
            chat_api: None,
        },
        &state.permissions,
    ))
}

/// WeldCommerce (`weldsuite-commerce`): commerce-api's routes at their own
/// prefixes (`/carriers`, `/products`, `/orders`, …), once the module is
/// marked ported.
fn commerce(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("commerce") {
        return router;
    }
    router.merge(weldsuite_commerce::router(
        commerce_state(state),
        &state.permissions,
    ))
}

/// WeldCommerce's public B2B portal at `/public/commerce-portal` (no
/// session: the workspace comes from its slug, the buyer from a session
/// token). Conformance builds open the test's tenant database and take its
/// user id, as the worker's test harness sets both.
fn commerce_public(state: &AppState) -> Router<AppState> {
    if !mounts("commerce") {
        return Router::new();
    }
    let portal = weldsuite_commerce::public_router(commerce_state(state));
    #[cfg(feature = "conformance")]
    let portal = portal
        .layer(axum::middleware::from_fn(
            crate::conformance::public_session,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.conformance_pools),
            crate::conformance::public_tenant,
        ));
    Router::new().nest("/public/commerce-portal", portal)
}

/// WeldCommerce's handle on the app: events, the workspace cache, system
/// mail, third-party HTTP, the portal's rate-limit counters (on the shared
/// cache's atomic counters), the master database and its env.
pub(crate) fn commerce_state(state: &AppState) -> weldsuite_commerce::CommerceState {
    static ENV: OnceLock<Arc<std::collections::HashMap<String, String>>> = OnceLock::new();
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    let conformance = cfg!(feature = "conformance");
    weldsuite_commerce::CommerceState {
        events: state.infra.events.clone(),
        // Conformance: the test's KV through the request only.
        cache: if conformance {
            None
        } else {
            state.infra.cache.clone()
        },
        mail: state.infra.mail.clone(),
        // Conformance builds take the test's bridge per request instead.
        http: HTTP
            .get_or_init(|| {
                (!conformance)
                    .then(|| {
                        weldsuite_adapters_oss::ReqwestOutbound::new(
                            std::time::Duration::from_secs(30),
                        )
                        .ok()
                    })
                    .flatten()
                    .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
            })
            .clone(),
        // Conformance: the test's PORTAL_RATE_LIMITER through the request.
        limiter: if conformance {
            None
        } else {
            state.infra.cache.clone().map(|cache| {
                Arc::new(weldsuite_commerce_domain::rate_limit::CacheRateLimitCounters::new(cache))
                    as Arc<dyn weldsuite_commerce_domain::rate_limit::RateLimitCounters>
            })
        },
        master: (!conformance).then(|| state.workspaces.master().clone()),
        workspaces: Some(Arc::clone(&state.workspaces)),
        env: Arc::clone(ENV.get_or_init(|| {
            let mut env = weldsuite_commerce::env_from_process();
            env.insert("ENVIRONMENT".to_owned(), state.environment.clone());
            Arc::new(env)
        })),
    }
}

/// WeldAds (`weldsuite-ads`): ads-api's `/api/ad-accounts`,
/// `/api/ad-campaigns` and `/api/ad-connections`.
fn ads(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("ads") {
        return router;
    }
    router.merge(weldsuite_ads::router(ads_state(state), &state.permissions))
}

/// WeldConnect (`weldsuite-connect`): connect-api's routes at their own
/// prefixes (`/workflows`, `/workflow-executions`, …), once the module is
/// marked ported.
fn connect(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("connect") {
        return router;
    }
    // Workflow runs (`EXECUTE_WORKFLOW`), where the jobs adapter calls them;
    // a `workflow_complete` chain starts the next run on the same jobs.
    let jobs = Arc::clone(&state.infra.jobs);
    state
        .infra
        .job_registry
        .register(weldsuite_connect::engine::ExecuteWorkflowJob {
            deps: weldsuite_connect::engine::EngineDeps {
                tenants: tenant_databases(state),
                realtime: state.infra.realtime.clone(),
                http: shared_outbound(),
                runs: Some(Arc::new(weldsuite_connect::JobsWorkflowRuns { jobs })),
                env: Arc::new(weldsuite_connect::engine::env_from_process()),
                events: state.infra.events.clone(),
                master: Some(state.workspaces.master().clone()),
                outbound: deployment_outbound(state),
            },
        });
    router.merge(weldsuite_connect::router(
        connect_state(state),
        &state.permissions,
    ))
}

/// WeldConnect's public routes (the workflow webhook receiver at
/// `/api/workflows/webhook/:id`). Conformance builds open the test's tenant
/// database for every workspace.
fn connect_public(state: &AppState) -> Router<AppState> {
    if !mounts("connect") {
        return Router::new();
    }
    let router = weldsuite_connect::public_router(connect_state(state)).merge(
        weldsuite_connect::workflow_actions_router(workflow_actions_state(state)),
    );
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// The workspaces' tenant databases, by `workspaces.id` or Clerk org id.
fn connect_tenants(state: &AppState) -> weldsuite_connect::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

/// WeldConnect's internal record actions (`/api/internal/workflow-actions/*`):
/// events, realtime, the master database (the calendar's due index), the
/// workspaces' databases and the env. Conformance builds take the test's
/// env, tenant and master database per request.
fn workflow_actions_state(state: &AppState) -> weldsuite_connect::WorkflowActionsState {
    let conformance = cfg!(feature = "conformance");
    let mut env = std::collections::HashMap::new();
    for name in ["INTERNAL_API_SECRET", "PERMISSIONS_APP_ENFORCE"] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.to_owned(), value);
        }
    }
    weldsuite_connect::WorkflowActionsState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        master: (!conformance).then(|| state.workspaces.master().clone()),
        tenants: Some(connect_tenants(state)),
        env: Arc::new(env),
    }
}

/// WeldConnect's handle on the app: events, the cache (the webhook
/// registry's), the master database, third-party HTTP, the jobs runs start
/// on and the workspaces' tenant databases. Conformance builds take the
/// test's KV, master database, fetch stub and Workflow binding per request.
pub(crate) fn connect_state(state: &AppState) -> weldsuite_connect::ConnectState {
    static ENV: OnceLock<Arc<std::collections::HashMap<String, String>>> = OnceLock::new();
    let conformance = cfg!(feature = "conformance");
    let workspaces = Arc::clone(&state.workspaces);
    let tenants: weldsuite_connect::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    weldsuite_connect::ConnectState {
        events: state.infra.events.clone(),
        cache: if conformance {
            None
        } else {
            state.infra.cache.clone()
        },
        master: (!conformance).then(|| state.workspaces.master().clone()),
        http: if conformance { None } else { shared_outbound() },
        jobs: (!conformance).then(|| Arc::clone(&state.infra.jobs)),
        tenants: Some(tenants),
        env: Arc::clone(ENV.get_or_init(|| {
            let mut env = weldsuite_connect::env_from_process();
            env.insert("ENVIRONMENT".to_owned(), state.environment.clone());
            Arc::new(env)
        })),
        trusted_proxies: state.trusted_proxies,
    }
}

/// WeldAds' handle on the app: events, the cache its OAuth state lives in,
/// the master database (the ad sync index) and Meta's API. Conformance
/// builds take the test's KV, master database and fetch stub per request.
fn ads_state(state: &AppState) -> weldsuite_ads::AdsState {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    let conformance = cfg!(feature = "conformance");
    weldsuite_ads::AdsState {
        events: state.infra.events.clone(),
        // Without Valkey the OAuth state lives in this process (one replica's worth).
        cache: (!conformance).then(|| upload_token_cache(state)),
        master: (!conformance).then(|| state.workspaces.master().clone()),
        http: if conformance {
            None
        } else {
            HTTP.get_or_init(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(30))
                    .ok()
                    .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
            })
            .clone()
        },
    }
}

/// WeldSocial (`weldsuite-social`): social-api's `/api/social-*`.
fn social(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("social") {
        return router;
    }
    router.merge(weldsuite_social::router(
        social_state(state),
        &state.permissions,
    ))
}

/// WeldData (`weldsuite-data`): data-api's `/api/welddata`,
/// `/api/enrich-fields` and `/api/enrichments`, and the
/// `data.welddata-enrich` job its column runs start.
fn data(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("data") {
        return router;
    }
    let http = shared_outbound();
    // Enrichment runs, where the jobs adapter calls them. The phone finder
    // reads company websites on public addresses only.
    match weldsuite_data::PublicPages::new() {
        Ok(pages) => state
            .infra
            .job_registry
            .register(weldsuite_data::WelddataEnrichJob {
                tenants: tenant_databases(state),
                http: http
                    .clone()
                    .unwrap_or_else(|| weldsuite_ports::OutboundHttp(Arc::new(NoOutbound))),
                pages: Arc::new(pages),
                keys: weldsuite_data::ActionKeys {
                    findymail_api_key: std::env::var("FINDYMAIL_API_KEY").ok(),
                    prospeo_api_key: std::env::var("PROSPEO_API_KEY").ok(),
                },
            }),
        Err(error) => tracing::error!(%error, "welddata: no HTTP client for the phone finder"),
    }
    let conformance = cfg!(feature = "conformance");
    let data = weldsuite_data::DataState {
        events: state.infra.events.clone(),
        cache: if conformance {
            None
        } else {
            state.infra.cache.clone()
        },
        http: if conformance { None } else { http },
        jobs: if conformance {
            None
        } else {
            Some(Arc::clone(&state.infra.jobs))
        },
    };
    router.merge(weldsuite_data::router(data, &state.permissions))
}

/// The third-party HTTP client the ported modules share (30 s), or none
/// when it cannot be built.
fn shared_outbound() -> Option<weldsuite_ports::OutboundHttp> {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    HTTP.get_or_init(|| {
        weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(30))
            .ok()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
    })
    .clone()
}

/// No HTTP client: every call fails like a `fetch` that can't connect.
struct NoOutbound;

impl weldsuite_ports::DynOutboundHttp for NoOutbound {
    fn send(
        &self,
        _request: weldsuite_ports::HttpRequest,
    ) -> weldsuite_ports::BoxFuture<
        '_,
        Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>,
    > {
        Box::pin(std::future::ready(Err(
            weldsuite_ports::PortError::backend("no outbound HTTP client"),
        )))
    }
}

/// PostPeer's delivery webhook (`/public/social/postpeer/webhook`), ahead of
/// the session; served with the social module. Conformance builds open the
/// test's tenant database for every workspace.
fn social_public(state: &AppState) -> Router<AppState> {
    if !mounts("social") {
        return Router::new();
    }
    let router = weldsuite_social::public_router(social_state(state));
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// WeldSocial's handle on the app: events, the cache (the webhook's legacy
/// post mapping), the master database (credits and the PostPeer post
/// index), PostPeer's API and the workspaces' tenant databases. Conformance
/// builds take the test's KV, master database and fetch stub per request.
fn social_state(state: &AppState) -> weldsuite_social::SocialState {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    let conformance = cfg!(feature = "conformance");
    let workspaces = Arc::clone(&state.workspaces);
    let tenants: weldsuite_social::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    weldsuite_social::SocialState {
        events: state.infra.events.clone(),
        cache: if conformance {
            None
        } else {
            state.infra.cache.clone()
        },
        master: (!conformance).then(|| state.workspaces.master().clone()),
        http: if conformance {
            None
        } else {
            HTTP.get_or_init(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(30))
                    .ok()
                    .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
            })
            .clone()
        },
        tenants: Some(tenants),
    }
}

/// WeldMail's handle on the app: databases, cache, files, jobs, system mail,
/// and the customer-mail transport and outbound ledgers ([`mail_outbound`]).
pub(crate) fn mail_state(state: &AppState) -> weldsuite_mail::MailState {
    static ENV: OnceLock<Arc<std::collections::HashMap<String, String>>> = OnceLock::new();
    weldsuite_mail::MailState {
        events: state.infra.events.clone(),
        master: Some(state.workspaces.master().clone()),
        cache: state.infra.cache.clone(),
        outbound: mail_outbound(state).0.clone(),
        files: file_stores(state),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        system_mail: state.infra.mail.clone(),
        // Expo push; conformance builds take the test's bridge per request.
        http: (!cfg!(feature = "conformance"))
            .then(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(15))
                    .ok()
            })
            .flatten()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client))),
        doh: Some(weldsuite_mail::send::reqwest_doh()),
        workspace_tenants: Some(mail_workspace_tenants(state)),
        env: Arc::clone(ENV.get_or_init(|| Arc::new(weldsuite_mail::env_from_process()))),
    }
}

/// The customer-mail bindings the modules that send for a workspace (CRM
/// sequences, Calendar invitations, Desk replies) use outside a request:
/// WeldMail's relay and ledgers ([`mail_outbound`]). Conformance builds keep
/// none here, so a test that binds no `SEND_EMAIL` / `OUTBOUND_LEDGER` gets
/// what the worker does without them; a test that binds them reaches the
/// module through the request's `RequestOutbound`.
fn deployment_outbound(state: &AppState) -> weldsuite_mail_domain::outbound::OutboundBindings {
    if cfg!(feature = "conformance") {
        weldsuite_mail_domain::outbound::OutboundBindings::default()
    } else {
        mail_outbound(state).0.clone()
    }
}

/// Customer mail and the outbound guard's ledgers, made once per process
/// (ADR MAIL-010):
///
/// - `MAIL_SMTP_URL`: the relay customer mail goes through, under its own
///   identity (not `SMTP_URL`, which is system mail's). Unset: sends answer
///   503, as the workers do without `SEND_EMAIL`.
/// - the ledgers on Valkey (`VALKEY_URL`, keys under
///   `VALKEY_LEDGER_PREFIX`, default `weldsuite:outbound:`), or in this
///   process without it (one replica's worth); `MAIL_DAILY_QUOTA` arms the
///   platform budget (`CF_EMAIL_DAILY_QUOTA` on Global).
/// - an in-process backstop (30 sends a minute per sender) for when the
///   ledgers can't be reached.
///
/// Conformance builds take the test's bindings per request instead.
pub(crate) fn mail_outbound(
    state: &AppState,
) -> &'static (
    weldsuite_mail_domain::outbound::OutboundBindings,
    Arc<weldsuite_mail_domain::outbound::StoreLedger>,
) {
    use weldsuite_mail_domain::outbound::{
        LedgerDeps, OutboundBindings, StoreLedger, WindowBackstop, clock,
    };
    static OUTBOUND: OnceLock<(OutboundBindings, Arc<StoreLedger>)> = OnceLock::new();
    OUTBOUND.get_or_init(|| {
        let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let transport = read("MAIL_SMTP_URL").and_then(|url| {
            weldsuite_adapters_oss::SmtpMailTransport::from_url(&url)
                .inspect_err(|error| tracing::error!(%error, "MAIL_SMTP_URL is not a relay URL"))
                .ok()
        });
        if transport.is_none() {
            tracing::warn!("MAIL_SMTP_URL is not set: customer mail cannot be sent");
        }
        let store: Arc<dyn weldsuite_ports::LedgerStore> = match read("VALKEY_URL").map(|url| {
            weldsuite_adapters_oss::ValkeyLedgerStore::from_url(
                &url,
                read("VALKEY_LEDGER_PREFIX").unwrap_or_else(|| "weldsuite:outbound:".to_owned()),
            )
        }) {
            Some(Ok(store)) => Arc::new(store),
            Some(Err(error)) => {
                tracing::error!(%error, "VALKEY_URL: the outbound ledgers stay in this process");
                Arc::new(weldsuite_ports::MemoryLedgerStore::new())
            }
            None => Arc::new(weldsuite_ports::MemoryLedgerStore::new()),
        };
        let ledger = Arc::new(StoreLedger::new(LedgerDeps {
            store,
            master: Some(state.workspaces.master().clone()),
            flags: Some(Arc::clone(&state.infra.flags)),
            reviews: None,
            daily_quota: read("MAIL_DAILY_QUOTA")
                .and_then(|v| v.parse().ok())
                .filter(|q| *q > 0),
            clock: clock::system_clock(),
        }));
        let bindings = OutboundBindings {
            transport: transport.map(|t| Arc::new(t) as Arc<dyn weldsuite_ports::MailTransport>),
            ledger: Some(
                Arc::clone(&ledger) as Arc<dyn weldsuite_mail_domain::outbound::OutboundLedger>
            ),
            platform: Some(ledger.platform()),
            backstop: Some(Arc::new(WindowBackstop::default())),
        };
        (bindings, ledger)
    })
}

/// WeldCalendar (`weldsuite-calendar`): calendar-api's `/api/booking-pages`,
/// `/api/bookings`, `/api/calendar-events`, `/api/calendars` and
/// `/api/working-hours`.
fn calendar(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("calendar") {
        return router;
    }
    router.merge(weldsuite_calendar::router(
        calendar_state(state),
        &state.permissions,
    ))
}

/// WeldCalendar's handle on the app: events, Google's API, the master
/// database (the re-plan due index) and the env it reads.
pub(crate) fn calendar_state(state: &AppState) -> weldsuite_calendar::CalendarState {
    static GOOGLE: OnceLock<Arc<dyn weldsuite_calendar::GoogleHttp>> = OnceLock::new();
    let mut env = std::collections::HashMap::new();
    env.insert("ENVIRONMENT".to_owned(), state.environment.clone());
    for name in [
        "APP_URL",
        "GOOGLE_CALENDAR_CLIENT_ID",
        "GOOGLE_CALENDAR_CLIENT_SECRET",
    ] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.to_owned(), value);
        }
    }
    weldsuite_calendar::CalendarState {
        events: state.infra.events.clone(),
        google: Some(Arc::clone(GOOGLE.get_or_init(|| {
            Arc::new(weldsuite_calendar::ReqwestGoogle::default())
        }))),
        // Conformance builds use the test's master database only, as the
        // worker uses its `SCHEDULE_INDEX` only when the test binds one.
        master: (!cfg!(feature = "conformance")).then(|| state.workspaces.master().clone()),
        env: Arc::new(env),
        // Attendee mail goes through WeldMail's relay and ledgers
        // ([`deployment_outbound`]); conformance takes the test's.
        outbound: deployment_outbound(state),
        cache: state.infra.cache.clone(),
    }
}

/// WeldDesk (`weldsuite-desk`): desk-api's paths under `/api`
/// (`/tickets`, `/conversations`, `/desk/*`, `/helpdesk-*`, …), merged at
/// their own prefixes as the worker mounts them.
fn desk(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("desk") {
        return router;
    }
    // ConversationWorkflow runs (`helpdesk-workflow-worker`), where the jobs
    // adapter calls them.
    state
        .infra
        .job_registry
        .register(weldsuite_desk_domain::workflow::ConversationWorkflowJob {
            deps: weldsuite_desk_domain::workflow::EngineDeps {
                tenants: tenant_databases(state),
                realtime: state.infra.realtime.clone(),
                http: Some(desk_http()),
                discord_bot_token: std::env::var("DISCORD_BOT_TOKEN")
                    .ok()
                    .filter(|token| !token.trim().is_empty()),
            },
        });
    router.merge(weldsuite_desk::router(
        desk_state(state),
        &state.permissions,
    ))
}

/// WeldDesk's routes ahead of the session (desk-api mounts them above
/// `apiAuth()`): the Discord and Slack OAuth callbacks
/// (`/api/integrations/helpdesk/*`) and the public help center
/// (`/public/helpcenter/*`). Served with the desk module. Conformance builds
/// open the test's tenant database for every workspace.
fn desk_public(state: &AppState) -> Router<AppState> {
    if !mounts("desk") {
        return Router::new();
    }
    let router =
        weldsuite_desk::public_router(desk_state(state), Some(Arc::clone(&state.workspaces)));
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// WeldDesk's helpdesk widget API (`weldsuite-desk-widget`, the
/// `helpdesk-widget-api` worker on Global): the public webchat API a site's
/// widget calls with its widget id, at `/public/helpdesk-widget`. Served with
/// the desk module, and merged outside the server's first-party CORS, as it
/// answers CORS for any origin itself. Conformance builds give it what the
/// test shares and open the test's tenant database for every workspace.
pub(crate) fn desk_widget(state: &AppState) -> Router {
    if !mounts("desk") {
        return Router::new();
    }
    let realtime = state.realtime.clone();
    let widget = weldsuite_desk_widget::router(weldsuite_desk_widget::WidgetState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        files: file_stores(state),
        cache: state.infra.cache.clone(),
        mail: state.infra.mail.clone(),
        master: Some(state.workspaces.master().clone()),
        workspaces: Some(Arc::clone(&state.workspaces)),
        // The helpdesk widget tests bind no `WORKFLOW_WORKER`: conformance
        // builds pick locally, as the worker does then.
        assignment: (!cfg!(feature = "conformance")).then(desk_assignment_router),
        settings: Arc::new(weldsuite_desk_widget::Settings {
            environment: state.environment.clone(),
            token_secret: state.widget_token_secret.as_deref().map(str::to_owned),
            public_storage_url: state.files_public_url.as_deref().map(str::to_owned),
            realtime_url: Arc::new(move |headers| realtime.url(headers)),
            trusted_proxies: state.trusted_proxies,
        }),
    });
    // Layers, not route layers: the widget's own 404 runs its middleware too.
    #[cfg(feature = "conformance")]
    let widget = widget
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.conformance_pools),
            crate::conformance::public_tenant,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.conformance_pools),
            crate::conformance::public,
        ));
    Router::new().nest("/public/helpdesk-widget", widget)
}

/// WeldDesk's handle on the app, with the helpdesk workflow engine in this
/// process (`HELPDESK_WORKFLOW` on Global). Conformance builds answer as the
/// worker does without the binding: the desk tests bind none.
fn desk_state(state: &AppState) -> weldsuite_desk::DeskState {
    let workflow: weldsuite_desk_domain::workflow::DynWorkflowEngine =
        if cfg!(feature = "conformance") {
            Arc::new(weldsuite_desk_domain::workflow::Unavailable)
        } else {
            Arc::new(weldsuite_desk_domain::workflow::InProcessEngine::new(
                tenant_databases(state),
                Arc::clone(&state.infra.jobs),
            ))
        };
    weldsuite_desk::DeskState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        files: file_stores(state),
        cache: state.infra.cache.clone(),
        mail: state.infra.mail.clone(),
        workflow,
        http: Some(desk_http()),
        // Email replies go through WeldMail's relay and ledgers
        // ([`deployment_outbound`]); conformance takes the test's.
        outbound: deployment_outbound(state),
        master: Some(state.workspaces.master().clone()),
    }
}

/// WeldFlow (`weldsuite-flow`): flow-api's prefixes, and the
/// `flow.import-tasks` job.
fn flow(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("flow") {
        return router;
    }
    let flow = flow_state(state);
    state
        .infra
        .job_registry
        .register(weldsuite_flow::ImportTasksJob {
            tenants: Some(flow_tenants(state)),
            storage: state.infra.public_files.clone(),
        });
    weldsuite_flow::routers(&flow, &state.permissions)
        .into_iter()
        .fold(router, |router, (prefix, routes)| {
            router.nest(prefix, routes)
        })
}

/// WeldFlow's handle on the app: events, files, the master database, jobs.
pub(crate) fn flow_state(state: &AppState) -> weldsuite_flow::FlowState {
    weldsuite_flow::FlowState {
        events: state.infra.events.clone(),
        // Conformance builds use only the buckets a test shares (`StorageBuckets`),
        // as a worker without `STORAGE` / `PRIVATE_STORAGE` runs without them.
        files: file_stores(state).filter(|_| !cfg!(feature = "conformance")),
        // Conformance builds have no master database of their own: a test
        // that shares one hands it in per request (`MasterDb`), as the
        // workers write their due index only when bound.
        master: (!cfg!(feature = "conformance")).then(|| state.workspaces.master().clone()),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        public_files_url: state.files_public_url.clone(),
        calendar: Arc::new(weldsuite_flow::calendar::CalendarSync),
        realtime: state.infra.realtime.clone(),
        // Expo push. Conformance builds take the test's bridge per request.
        http: (!cfg!(feature = "conformance"))
            .then(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(15))
                    .ok()
            })
            .flatten()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client))),
    }
}

/// A workspace's tenant database for WeldFlow's jobs.
fn flow_tenants(state: &AppState) -> weldsuite_flow::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

/// WeldPass: the root keys (`WELDPASS_ROOT_KEY`, `WELDPASS_ROOT_KEY_V2`)
/// from the environment and one HTTP client for the deploy targets, made
/// once per process. Conformance builds take the test's keys and its
/// `fetch` stub per request instead.
fn pass_state() -> weldsuite_pass::PassState {
    static STATE: OnceLock<weldsuite_pass::PassState> = OnceLock::new();
    STATE
        .get_or_init(weldsuite_pass::PassState::from_env)
        .clone()
}

/// WeldDesk's `AssignmentRouter` (ADR DESK-005), one per process: its
/// records on Valkey (`VALKEY_URL`, keys under
/// `VALKEY_DESK_ASSIGNMENT_PREFIX`, default `weldsuite:desk-assignment:`),
/// so round robin and recent picks hold across pods; in this process without
/// it (one replica's worth).
pub(crate) fn desk_assignment_router()
-> Arc<weldsuite_desk_domain::assignment_router::AssignmentRouter> {
    static ROUTER: OnceLock<Arc<weldsuite_desk_domain::assignment_router::AssignmentRouter>> =
        OnceLock::new();
    Arc::clone(ROUTER.get_or_init(|| {
        let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let store: Arc<dyn weldsuite_ports::LedgerStore> = match read("VALKEY_URL").map(|url| {
            weldsuite_adapters_oss::ValkeyLedgerStore::from_url(
                &url,
                read("VALKEY_DESK_ASSIGNMENT_PREFIX")
                    .unwrap_or_else(|| "weldsuite:desk-assignment:".to_owned()),
            )
        }) {
            Some(Ok(store)) => Arc::new(store),
            Some(Err(error)) => {
                tracing::error!(%error, "VALKEY_URL: the desk assignment router stays in this process");
                Arc::new(weldsuite_ports::MemoryLedgerStore::new())
            }
            None => Arc::new(weldsuite_ports::MemoryLedgerStore::new()),
        };
        Arc::new(weldsuite_desk_domain::assignment_router::AssignmentRouter::new(store))
    }))
}

/// WeldDesk's Discord and Slack client, one per process.
fn desk_http() -> weldsuite_desk_domain::http::DynDeskHttp {
    static HTTP: OnceLock<weldsuite_desk_domain::http::DynDeskHttp> = OnceLock::new();
    Arc::clone(HTTP.get_or_init(|| Arc::new(crate::desk_http::ReqwestDeskHttp::default())))
}

/// Core files, drive, search and storage (P4c), with the 30-day purge
/// `DELETE /api/files/:id` starts. Mounted with core, like [`core_team`].
fn core_files(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("core") {
        return router;
    }
    let files = core_files_state(state);
    state
        .infra
        .job_registry
        .register(weldsuite_core_files::TrashPurgeJob::new(
            tenant_databases(state),
            file_stores(state),
        ));
    let gate = &state.permissions;
    router
        .nest(
            "/storage",
            weldsuite_core_files::storage_router(files.clone(), gate),
        )
        .nest(
            "/files",
            weldsuite_core_files::files_router(files.clone(), gate),
        )
        .nest(
            "/folders",
            weldsuite_core_files::folders_router(files.clone(), gate),
        )
        .nest(
            "/drive",
            weldsuite_core_files::drive_router(files.clone(), gate),
        )
        .nest("/search", weldsuite_core_files::search_router(files, gate))
}

/// The routes served before authentication, at their full paths:
/// `/api/storage/upload/:token`, `/api/storage/private/*` and
/// `/api/storage/public/*` (each checks its own credential), the CLI's
/// device login (`/api/cli-auth/device`, `/api/cli-auth/token`) and the
/// WeldApps bundle host (`/public/user-apps/*`). Empty where core is not
/// mounted.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    let router = public_core(state)
        .merge(desk_public(state))
        .merge(social_public(state))
        .merge(books::public(state))
        .merge(commerce_public(state))
        .merge(connect_public(state));
    if mounts("mail") {
        router
            .nest(
                "/internal/outbound",
                weldsuite_mail::internal_outbound_router(mail_state(state)),
            )
            // Haraka's `RCPT TO` check (MAIL-010): the master registry,
            // behind `MAIL_INBOUND_SECRET`.
            .nest(
                "/internal/mail-inbound",
                weldsuite_mail_inbound::rcpt::router(
                    state.workspaces.master().clone(),
                    state.mail_inbound_secret.as_deref().map(str::to_owned),
                ),
            )
    } else {
        router
    }
}

fn public_core(state: &AppState) -> Router<AppState> {
    if mounts("core") {
        let apps = core_apps_state(state);
        weldsuite_core_files::storage_public_router(core_files_state(state))
            .nest(
                "/api/cli-auth",
                weldsuite_core_apps::cli_auth_public(apps.clone()),
            )
            .nest(
                "/public/user-apps",
                weldsuite_core_apps::public_user_apps(apps),
            )
    } else {
        Router::new()
    }
}

/// The core files state, shared by the authenticated and the public routes.
fn core_files_state(state: &AppState) -> weldsuite_core_files::CoreFilesState {
    weldsuite_core_files::CoreFilesState {
        events: state.infra.events.clone(),
        files: file_stores(state),
        public_files_url: state.files_public_url.clone(),
        storage: weldsuite_core_files::StorageState {
            cache: Some(upload_token_cache(state)),
            verifier: Some(Arc::clone(&state.verifier)),
            signing_key: state.storage_signing_key.clone(),
            environment: Arc::from(state.environment.as_str()),
            jobs: Some(Arc::clone(&state.infra.jobs)),
        },
    }
}

/// Where upload tokens live: Valkey, or without it one in-process cache for
/// the whole process (enough for a single replica), shared by the route that
/// mints a token and the one that redeems it.
fn upload_token_cache(state: &AppState) -> Arc<dyn DynCache> {
    static LOCAL: OnceLock<Arc<dyn DynCache>> = OnceLock::new();
    state.infra.cache.clone().unwrap_or_else(|| {
        Arc::clone(LOCAL.get_or_init(|| {
            tracing::warn!("VALKEY_URL is not set: upload tokens live in this process only");
            Arc::new(MemoryCache::new())
        }))
    })
}

/// A workspace's tenant database for jobs, which run outside any request.
fn tenant_databases(state: &AppState) -> weldsuite_core_files::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

/// WeldSign's handle on the app: databases, files, mail, cache, flags, jobs.
pub(crate) fn sign_state(state: &AppState) -> weldsuite_sign::SignState {
    weldsuite_sign::SignState {
        events: state.infra.events.clone(),
        session_secret: state.sign_session_secret.clone(),
        files: file_stores(state),
        master: Some(state.workspaces.master().clone()),
        mail: state.infra.mail.clone(),
        cache: state.infra.cache.clone(),
        flags: Arc::clone(&state.infra.flags),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        portal_url: state.sign_portal_url.clone(),
        environment: Some(Arc::from(state.environment.as_str())),
    }
}

/// WeldSign's signer portal at `/public/sign-portal` (ADR FE-017): outside
/// the member pipeline, behind the portal's key; served with the sign
/// module. Conformance builds take the test's databases, KV namespace and
/// Workflow binding from its context.
pub(crate) fn sign_portal(state: &AppState) -> Router<AppState> {
    if !mounts("sign") {
        return Router::new();
    }
    let portal = weldsuite_sign::PortalState::new(
        sign_state(state),
        Some(Arc::clone(&state.workspaces)),
        state.sign_portal_secret.clone(),
    );
    let router = weldsuite_sign::portal_router(portal);
    #[cfg(feature = "conformance")]
    let router = router.layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance_portal::context,
    ));
    router
}

/// The private bucket and the legacy public one, when object storage is
/// configured.
fn file_stores(state: &AppState) -> Option<weldsuite_ports::FileStores> {
    state
        .infra
        .files
        .clone()
        .map(|private| weldsuite_ports::FileStores {
            private,
            public: state.infra.public_files.clone(),
        })
}

/// The team and settings routes of the core platform
/// (`weldsuite-core-team`), each at its app-api prefix.
///
/// Mounted wherever core is marked ported (`RUST_PORTED_MODULES` in
/// `packages/core/api-modules`), which needs every core suite to pass with
/// every route covered; conformance builds always mount it.
fn core_team(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("core") {
        return router;
    }
    let team = core_team_state(state);
    let gate = &state.permissions;
    router
        .nest(
            "/team-members",
            weldsuite_core_team::team_members(team.clone(), gate),
        )
        .nest("/roles", weldsuite_core_team::roles(team.clone(), gate))
        .nest("/my-role", weldsuite_core_team::my_role(team.clone(), gate))
        .nest(
            "/member-limits",
            weldsuite_core_team::member_limits(team.clone(), gate),
        )
        .nest(
            "/prepaid-seats",
            weldsuite_core_team::prepaid_seats(team.clone(), gate),
        )
        .nest(
            "/workspace-settings",
            weldsuite_core_team::workspace_settings(team.clone(), gate),
        )
        .nest(
            "/settings/profile",
            weldsuite_core_team::settings_profile(team.clone(), gate),
        )
        .nest(
            "/user-preferences",
            weldsuite_core_team::user_preferences(team.clone(), gate),
        )
        .nest(
            "/notification-preferences",
            weldsuite_core_team::notification_preferences(team.clone(), gate),
        )
        .nest(
            "/push-tokens",
            weldsuite_core_team::push_tokens(team.clone(), gate),
        )
        .nest(
            "/app-catalog",
            weldsuite_core_team::app_catalog(team.clone(), gate),
        )
        .nest("/workspaces", weldsuite_core_team::workspaces(team, gate))
}

/// The smaller core platform route groups (`weldsuite-core-platform`), each
/// at its app-api prefix: notifications, audit logs, API keys, the dashboard,
/// credits, support, feature requests, SSO, auth sessions and the app store
/// (P4, sub-phases 4b/4d).
///
/// Mounted with core, like [`core_team`].
fn core_platform(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("core") {
        return router;
    }
    let platform = weldsuite_core_platform::CorePlatformState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        cache: state.infra.cache.clone(),
        master: state.workspaces.master().clone(),
        // Zitadel when configured; conformance builds take the test's per
        // request.
        identity: state.infra.identity.clone(),
    };
    let gate = &state.permissions;
    router
        .nest(
            "/notifications",
            weldsuite_core_platform::notifications(platform.clone(), gate),
        )
        .nest(
            "/audit-logs",
            weldsuite_core_platform::audit_logs(platform.clone(), gate),
        )
        .nest(
            "/api-keys",
            weldsuite_core_platform::api_keys(platform.clone(), gate),
        )
        .nest(
            "/workspace-api-keys",
            weldsuite_core_platform::workspace_api_keys(platform.clone(), gate),
        )
        .nest(
            "/dashboard",
            weldsuite_core_platform::dashboard(platform.clone(), gate),
        )
        .nest(
            "/credits",
            weldsuite_core_platform::credits(platform.clone(), gate),
        )
        .nest(
            "/support",
            weldsuite_core_platform::support(platform.clone(), gate),
        )
        .nest(
            "/feature-requests",
            weldsuite_core_platform::feature_requests(platform.clone(), gate),
        )
        .nest("/sso", weldsuite_core_platform::sso(platform.clone(), gate))
        .nest(
            "/auth-sessions",
            weldsuite_core_platform::auth_sessions(platform.clone(), gate),
        )
        .nest(
            "/appstore",
            weldsuite_core_platform::appstore(platform, gate),
        )
}

/// The routes that need a session but no workspace (app-api mounts them
/// above its `/api/*` guard): `/api/account`, `/api/invitations`. Relative
/// to `/api`; the server puts only the session layer in front of them.
///
/// Mounted with core, like [`core_team`].
pub(crate) fn account(state: &AppState) -> Router<AppState> {
    let router = onboarding(state);
    // WeldMail's mailbox directory reads every workspace the user belongs to.
    let router = if mounts("mail") {
        router.merge(weldsuite_mail::mailboxes_router(mail_state(state)))
    } else {
        router
    };
    if !mounts("core") {
        return router;
    }
    let team = core_team_state(state);
    router
        .nest("/account", weldsuite_core_team::account(team.clone()))
        .nest("/invitations", weldsuite_core_team::invitations(team))
        .nest(
            "/auth-desktop",
            weldsuite_core_apps::auth_desktop(core_apps_state(state)),
        )
}

/// `/api/onboarding` (`weldsuite-core-onboarding`, P4 4a): signup and the
/// first workspace. Served in conformance builds, and wherever workspaces
/// can be provisioned (`TENANT_SHARDS` set), which is what signing up on
/// the Kubernetes editions needs; the provisioning job is registered there.
fn onboarding(state: &AppState) -> Router<AppState> {
    let provisioner = state.infra.provisioner.clone();
    if !cfg!(feature = "conformance") && provisioner.is_none() {
        return Router::new();
    }
    let tenants = onboarding_tenants(state);
    let workspace_service = if let (Some(identity), Some(provisioner)) =
        (&state.infra.identity, &provisioner)
    {
        state
            .infra
            .job_registry
            .register(weldsuite_core_onboarding::ProvisionJob::new(
                state.workspaces.master().clone(),
                Arc::clone(provisioner),
                Arc::clone(&tenants),
                Some(Arc::clone(identity)),
            ));
        Some(Arc::new(weldsuite_core_onboarding::WorkspaceService::new(
            state.workspaces.master().clone(),
            Arc::clone(identity),
            Arc::clone(&state.infra.jobs),
            state.infra.cache.clone(),
        )))
    } else {
        if provisioner.is_some() {
            tracing::warn!(
                "TENANT_SHARDS is set but ZITADEL_API_URL is not: signup cannot create workspaces"
            );
        }
        None
    };
    let onboarding = weldsuite_core_onboarding::OnboardingState {
        events: state.infra.events.clone(),
        master: state.workspaces.master().clone(),
        tenants,
        identity: state.infra.identity.clone(),
        mail: state.infra.mail.clone(),
        workspace_service,
    };
    Router::new().nest("/onboarding", weldsuite_core_onboarding::router(onboarding))
}

/// A workspace's tenant database for onboarding's job and `/finalize`,
/// which run outside the tenant layer.
fn onboarding_tenants(state: &AppState) -> weldsuite_core_onboarding::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

/// WeldApps (`weldsuite-core-apps`): `/api/user-apps` and the CLI login's
/// approval, behind the session and workspace layers.
///
/// Mounted with core, like [`core_team`].
fn core_apps(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("core") {
        return router;
    }
    let apps = core_apps_state(state);
    router
        .nest(
            "/user-apps",
            weldsuite_core_apps::user_apps(apps.clone(), &state.permissions),
        )
        .nest("/cli-auth", weldsuite_core_apps::cli_auth_approve(apps))
}

/// What the WeldApps routers share in the process: the outbound HTTP client,
/// the env settings they read (`EXTERNAL_API_URL`, the bundle signing secret,
/// …) and the app gateway's token cache.
type AppsShared = (
    std::sync::Arc<dyn weldsuite_core_apps::HttpTransport>,
    std::sync::Arc<std::collections::HashMap<String, String>>,
    std::sync::Arc<weldsuite_core_apps::GatewayTokens>,
);

fn apps_shared() -> &'static AppsShared {
    static SHARED: std::sync::OnceLock<AppsShared> = std::sync::OnceLock::new();
    SHARED.get_or_init(|| {
        (
            std::sync::Arc::new(weldsuite_core_apps::ReqwestTransport::new()),
            std::sync::Arc::new(weldsuite_core_apps::CoreAppsState::env_from_process()),
            std::sync::Arc::default(),
        )
    })
}

/// The env settings of the WeldApps routes, for the server's bundle-host
/// guard.
pub(crate) fn apps_env() -> std::sync::Arc<std::collections::HashMap<String, String>> {
    std::sync::Arc::clone(&apps_shared().1)
}

fn core_apps_state(state: &AppState) -> weldsuite_core_apps::CoreAppsState {
    let (http, env, gateway_tokens) = apps_shared();
    weldsuite_core_apps::CoreAppsState {
        events: state.infra.events.clone(),
        master: state.workspaces.master().clone(),
        workspaces: std::sync::Arc::clone(&state.workspaces),
        cache: state.infra.cache.clone(),
        files: file_stores(state),
        // Zitadel when configured; conformance builds take the test's per
        // request.
        identity: state.infra.identity.clone(),
        http: std::sync::Arc::clone(http),
        env: std::sync::Arc::clone(env),
        gateway_tokens: std::sync::Arc::clone(gateway_tokens),
    }
}

fn core_team_state(state: &AppState) -> weldsuite_core_team::CoreTeamState {
    weldsuite_core_team::CoreTeamState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        cache: state.infra.cache.clone(),
        files: state
            .infra
            .files
            .clone()
            .map(|private| weldsuite_ports::FileStores {
                private,
                public: state.infra.public_files.clone(),
            }),
        master: state.workspaces.master().clone(),
        workspaces: std::sync::Arc::clone(&state.workspaces),
        // Zitadel when configured; conformance builds take the test's per
        // request.
        identity: state.infra.identity.clone(),
    }
}

/// Whether to serve a module: it is marked ported (`ApiModule.rust`, WP
/// 1.10). Conformance builds serve every module with a crate, so a port is
/// checked against its TypeScript tests before it is marked.
fn mounts(module: &str) -> bool {
    cfg!(feature = "conformance")
        || weldsuite_catalogs::api_modules()
            .iter()
            .any(|m| m.id == module && m.rust)
}

/// WeldChat (`weldsuite-chat`): chat-api's object routes, each at its own
/// prefix, once the module is marked ported (always in conformance builds).
fn chat(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("chat") {
        return router;
    }
    let chat = chat_state(state);
    // The pin auto-expiry runs where the jobs adapter calls it.
    state
        .infra
        .job_registry
        .register(weldsuite_chat::UnpinExpiredMessageJob {
            tenants: chat_tenants(state),
            realtime: state.infra.realtime.clone(),
        });
    let gate = &state.permissions;
    router
        .nest(
            "/channel-members",
            weldsuite_chat::channel_members(chat.clone(), gate),
        )
        .nest("/channels", weldsuite_chat::channels(chat.clone(), gate))
        .nest(
            "/chat-activity",
            weldsuite_chat::activity(chat.clone(), gate),
        )
        .nest("/chat-clips", weldsuite_chat::clips(chat.clone(), gate))
        .nest(
            "/chat-directories",
            weldsuite_chat::directories(chat.clone(), gate),
        )
        .nest("/chat-dm", weldsuite_chat::dm(chat.clone(), gate))
        .nest("/chat-search", weldsuite_chat::search(chat.clone(), gate))
        .nest(
            "/chat-messages",
            weldsuite_chat::messages(chat.clone(), gate),
        )
        .nest(
            "/chat-entity-channels",
            weldsuite_chat::record_chats(chat.clone(), gate),
        )
        .nest(
            "/chat-bookmarks",
            weldsuite_chat::bookmarks(chat.clone(), gate),
        )
        .nest("/chat-drafts", weldsuite_chat::drafts(chat.clone(), gate))
        .nest(
            "/chat-sections",
            weldsuite_chat::sections(chat.clone(), gate),
        )
        .nest("/chat-status", weldsuite_chat::status(chat, gate))
}

/// WeldChat's handle on the app: events, realtime, files, jobs, its env.
fn chat_state(state: &AppState) -> weldsuite_chat::ChatState {
    static ENV: std::sync::OnceLock<Arc<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    let env = ENV.get_or_init(|| {
        let names = [
            "R2_PUBLIC_URL",
            "PUBLIC_APP_URL",
            "CALL_RING_SECRET",
            "APNS_KEY_ID",
            "APNS_TEAM_ID",
            "APNS_PRIVATE_KEY",
        ];
        Arc::new(
            names
                .iter()
                .filter_map(|name| {
                    std::env::var(name)
                        .ok()
                        .map(|value| ((*name).to_owned(), value))
                })
                .collect(),
        )
    });
    weldsuite_chat::ChatState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        // Conformance: the test's KV through the request only, as a worker
        // without the binding has no rate limit or call bookkeeping.
        cache: if cfg!(feature = "conformance") {
            None
        } else {
            state.infra.cache.clone()
        },
        // Conformance: the test's STORAGE bucket through the request only.
        files: if cfg!(feature = "conformance") {
            None
        } else {
            file_stores(state)
        },
        jobs: Some(Arc::clone(&state.infra.jobs)),
        unpin_jobs: !cfg!(feature = "conformance"),
        // Expo and APNs push. Conformance builds take the test's bridge per
        // request instead.
        http: (!cfg!(feature = "conformance"))
            .then(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(15))
                    .ok()
            })
            .flatten()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client))),
        presence: None,
        env: Arc::clone(env),
    }
}

/// Another workspace's tenant database and its suspension, for WeldMail's
/// mailbox directory (`/api/mailboxes`).
fn mail_workspace_tenants(state: &AppState) -> weldsuite_mail::WorkspaceTenants {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| (tenant.db, tenant.suspended))
                .map_err(|error| error.to_string())
        })
    })
}

/// A workspace's tenant database for WeldMail's scheduled-send job.
fn mail_tenants(state: &AppState) -> weldsuite_mail::scheduled::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

/// A workspace's tenant database for WeldChat's jobs.
fn chat_tenants(state: &AppState) -> weldsuite_chat::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}
