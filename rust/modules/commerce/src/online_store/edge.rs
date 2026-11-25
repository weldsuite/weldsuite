//! The storefront edge: every request to a shop host, on a listener of its
//! own (`STOREFRONT_LISTEN`), so shop hosts can never reach the platform's
//! API or the SPA. Each shop host's `Ingress` (and the wildcard one of the
//! free addresses) routes to that listener's port.
//!
//! Per request, by `Host`:
//!
//! 1. A deployment preview host (`sfd-…--<shop>.<base>`): that deployment's
//!    files, `noindex`.
//! 2. The host, looked up in the master `storefront_hosts` (cached): unknown
//!    or not active → 404. A host that isn't the site's primary one → 301 to
//!    the primary, same path. Plain HTTP → 308 to HTTPS.
//! 3. The workspace suspended or without WeldCommerce → 404.
//! 4. Coming soon → 503 page; password → the password page until a visitor
//!    pass cookie is set (`POST /__password`). A preview (the `wsf_preview`
//!    cookie, or `/__preview`) passes; the renderer and the backend check
//!    its token.
//! 5. A static deployment → its file ([`serve_static`]); a builder site →
//!    proxied to the storefront renderer with the edge's headers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::Workspaces;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::config::OnlineStoreConfig;
use super::deployments::{MANIFEST, content_type, parse_preview_host, prefix};
use super::registry::{self, HostEntry};
use super::tokens;
use crate::storefront::limit;

/// Request bodies the edge forwards (forms: cart, checkout, sign-in).
const MAX_BODY: usize = 1024 * 1024;
/// Manifests kept in memory.
const MAX_MANIFESTS: usize = 512;
const PREVIEW_COOKIE: &str = "wsf_preview";
const PASS_COOKIE: &str = "wsf_pass";

/// What the edge needs from the server.
#[derive(Clone)]
pub struct EdgeState {
    pub master: PgPool,
    pub workspaces: Arc<Workspaces>,
    pub config: OnlineStoreConfig,
    /// `STOREFRONT_RENDERER_URL`, the renderer's Service; `None`: builder
    /// sites answer 503.
    pub renderer_url: Option<String>,
    /// The client for the renderer: follows no redirects.
    pub renderer: Option<OutboundHttp>,
    /// `STOREFRONT_EDITOR_ORIGINS`: who may frame a preview.
    pub editor_origins: Vec<String>,
    /// `TRUSTED_PROXIES`.
    pub trusted_proxies: usize,
    manifests: Arc<Mutex<HashMap<String, Arc<Manifest>>>>,
}

impl std::fmt::Debug for EdgeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EdgeState")
            .field("renderer_url", &self.renderer_url)
            .field("editor_origins", &self.editor_origins)
            .finish_non_exhaustive()
    }
}

impl EdgeState {
    pub fn new(
        master: PgPool,
        workspaces: Arc<Workspaces>,
        config: OnlineStoreConfig,
        renderer_url: Option<String>,
        renderer: Option<OutboundHttp>,
        editor_origins: Vec<String>,
        trusted_proxies: usize,
    ) -> Self {
        Self {
            master,
            workspaces,
            config,
            renderer_url: renderer_url.map(|url| url.trim_end_matches('/').to_owned()),
            renderer,
            editor_origins,
            trusted_proxies,
            manifests: Arc::default(),
        }
    }
}

/// The edge's router: everything is [`serve`].
pub fn edge_router(state: EdgeState) -> Router {
    Router::new()
        .route("/__edge/healthz", axum::routing::get(|| async { "ok" }))
        .fallback(serve)
        .with_state(state)
}

/// The host a request was sent to, lower case, without port or root dot.
fn request_host(request: &Request) -> Option<String> {
    let raw = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| request.uri().host())?;
    let without_port = match raw.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => raw,
    };
    let host = weldsuite_custom_domains::normalize_host(without_port);
    (!host.is_empty()).then_some(host)
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned())
}

/// The few languages of the edge's own pages.
fn language(headers: &HeaderMap) -> &'static str {
    let accept = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    for part in accept.split(',') {
        let tag = part.split(';').next().unwrap_or_default().trim();
        for lang in ["nl", "de", "fr", "en"] {
            if tag == lang || tag.starts_with(&format!("{lang}-")) {
                return lang;
            }
        }
    }
    "en"
}

fn text(lang: &str, key: &str) -> &'static str {
    match (lang, key) {
        ("nl", "missing") => "Hier is geen winkel.",
        ("de", "missing") => "Hier gibt es keinen Shop.",
        ("fr", "missing") => "Il n’y a pas de boutique ici.",
        (_, "missing") => "There is no shop here.",
        ("nl", "soon") => "Deze winkel gaat binnenkort open.",
        ("de", "soon") => "Dieser Shop öffnet bald.",
        ("fr", "soon") => "Cette boutique ouvre bientôt.",
        (_, "soon") => "This shop opens soon.",
        ("nl", "locked") => "Deze winkel is beveiligd met een wachtwoord.",
        ("de", "locked") => "Dieser Shop ist passwortgeschützt.",
        ("fr", "locked") => "Cette boutique est protégée par un mot de passe.",
        (_, "locked") => "This shop is protected by a password.",
        ("nl", "password") => "Wachtwoord",
        ("de", "password") => "Passwort",
        ("fr", "password") => "Mot de passe",
        (_, "password") => "Password",
        ("nl", "enter") => "Openen",
        ("de", "enter") => "Öffnen",
        ("fr", "enter") => "Entrer",
        (_, "enter") => "Enter",
        ("nl", "wrong") => "Dat wachtwoord klopt niet.",
        ("de", "wrong") => "Das Passwort ist falsch.",
        ("fr", "wrong") => "Ce mot de passe est incorrect.",
        (_, "wrong") => "That password is not right.",
        ("nl", "unavailable") => "De winkel is even niet bereikbaar. Probeer het later opnieuw.",
        ("de", "unavailable") => {
            "Der Shop ist gerade nicht erreichbar. Bitte später erneut versuchen."
        }
        ("fr", "unavailable") => "La boutique est momentanément indisponible. Réessayez plus tard.",
        (_, "unavailable") => "The shop can’t be reached right now. Please try again later.",
        _ => "",
    }
}

/// A small page of the edge's own: no scripts, no outside resources.
fn page(status: StatusCode, lang: &str, title: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{title}</title>\
         <style>:root{{color-scheme:light dark}}body{{font:16px/1.5 system-ui,sans-serif;\
         display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}}\
         main{{max-width:28rem;text-align:center}}input,button{{font:inherit;padding:.6rem .8rem;\
         border-radius:.4rem;border:1px solid #8888}}button{{cursor:pointer}}\
         form{{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;margin-top:1rem}}\
         label{{position:absolute;left:-9999px}}</style></head>\
         <body><main>{body}</main></body></html>"
    );
    let mut response = (status, html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    secure(headers, true);
    response
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn missing(lang: &str) -> Response {
    let message = text(lang, "missing");
    page(
        StatusCode::NOT_FOUND,
        lang,
        message,
        &format!("<h1>{message}</h1>"),
    )
}

fn unavailable_page(lang: &str) -> Response {
    let message = text(lang, "unavailable");
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        lang,
        message,
        &format!("<p>{message}</p>"),
    )
}

fn password_page(lang: &str, wrong: bool) -> Response {
    let notice = if wrong {
        format!("<p role=\"alert\">{}</p>", text(lang, "wrong"))
    } else {
        String::new()
    };
    let body = format!(
        "<h1>{}</h1>{notice}<form method=\"post\" action=\"/__password\">\
         <label for=\"p\">{}</label><input id=\"p\" name=\"password\" type=\"password\" \
         autocomplete=\"current-password\" required autofocus placeholder=\"{}\">\
         <button type=\"submit\">{}</button></form>",
        text(lang, "locked"),
        text(lang, "password"),
        text(lang, "password"),
        text(lang, "enter"),
    );
    page(
        if wrong {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::UNAUTHORIZED
        },
        lang,
        text(lang, "locked"),
        &body,
    )
}

/// The edge's own security headers on every answer.
fn secure(headers: &mut HeaderMap, frame_none: bool) {
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    if !headers.contains_key(header::REFERRER_POLICY) {
        headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        );
    }
    if frame_none {
        headers.append(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'self'"),
        );
    }
}

fn redirect(status: StatusCode, location: &str) -> Response {
    let mut response = status.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

/// What the edge reads of a request, apart from its body (which isn't
/// `Sync`, so a reference to the request can't be held across an await).
struct Incoming {
    method: Method,
    path: String,
    path_and_query: String,
    headers: HeaderMap,
}

impl Incoming {
    fn of(request: &Request) -> Self {
        Self {
            method: request.method().clone(),
            path: request.uri().path().to_owned(),
            path_and_query: request
                .uri()
                .path_and_query()
                .map_or_else(|| "/".to_owned(), |pq| pq.as_str().to_owned()),
            headers: request.headers().clone(),
        }
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the steps in the order the module documents them"
)]
async fn serve(State(state): State<EdgeState>, request: Request) -> Response {
    let incoming = Incoming::of(&request);
    let lang = language(&incoming.headers);
    let Some(host) = request_host(&request) else {
        return missing(lang);
    };
    // 1. A deployment's preview.
    if let Some((deployment, shop_host)) = parse_preview_host(&host)
        && state
            .config
            .base_domain
            .as_deref()
            .is_some_and(|base| shop_host.ends_with(&format!(".{base}")))
    {
        return preview_deployment(&state, &incoming, &deployment, &shop_host, lang).await;
    }
    // 2. The host.
    let entry = match registry::lookup(&state.master, state.config.cache.as_ref(), &host).await {
        Ok(Some(entry)) => entry,
        Ok(None) => return missing(lang),
        Err(error) => {
            tracing::error!(%error, "[storefront-edge] host lookup failed");
            return unavailable_page(lang);
        }
    };
    let proto_http = incoming
        .headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|p| p.eq_ignore_ascii_case("http"));
    if proto_http && state.config.scheme() == "https" {
        return redirect(
            StatusCode::PERMANENT_REDIRECT,
            &format!("https://{host}{}", incoming.path_and_query),
        );
    }
    let path = incoming.path.clone();
    let previewing = path == "/__preview" || cookie(&incoming.headers, PREVIEW_COOKIE).is_some();
    if !entry.is_primary && !previewing {
        return redirect(
            StatusCode::MOVED_PERMANENTLY,
            &format!(
                "{}{}",
                state.config.origin(&entry.primary_host),
                incoming.path_and_query
            ),
        );
    }
    // 3. The workspace.
    match state.workspaces.tenant(&entry.workspace_id).await {
        Ok(tenant) => {
            let licensed = tenant
                .licensed_apps()
                .is_none_or(|apps| apps.iter().any(|a| a == "weldcommerce"));
            if tenant.suspended || !licensed {
                return missing(lang);
            }
        }
        Err(error) => {
            tracing::error!(%error, "[storefront-edge] workspace lookup failed");
            return unavailable_page(lang);
        }
    }
    // 4. Visibility.
    if !previewing {
        match entry.visibility.as_str() {
            "coming_soon" => {
                let message = text(lang, "soon");
                return page(
                    StatusCode::SERVICE_UNAVAILABLE,
                    lang,
                    message,
                    &format!("<h1>{}</h1>", escape(message)),
                );
            }
            "password" => {
                if let Some(response) = password_gate(&state, &entry, &host, &incoming, lang) {
                    return response;
                }
                if path == "/__password" && incoming.method == Method::POST {
                    return password_submit(&state, &entry, &host, request, lang).await;
                }
            }
            _ => {}
        }
    }
    // 5. What the site serves.
    let soon = || {
        let message = text(lang, "soon");
        page(
            StatusCode::SERVICE_UNAVAILABLE,
            lang,
            message,
            &format!("<h1>{}</h1>", escape(message)),
        )
    };
    if entry.mode == "static" {
        let Some(deployment) = entry.deployment_id.as_deref() else {
            return soon();
        };
        return serve_static(
            &state,
            &incoming,
            &entry.workspace_id,
            &entry.site_id,
            deployment,
            false,
        )
        .await;
    }
    if entry.published_version_id.is_none() && !previewing {
        return soon();
    }
    proxy(
        &state,
        &entry,
        &host,
        incoming,
        request.into_body(),
        previewing,
    )
    .await
}

/// `None` when the visitor may see the shop (a valid pass) or is posting the
/// password (`POST /__password`); the password page otherwise.
fn password_gate(
    state: &EdgeState,
    entry: &HostEntry,
    host: &str,
    request: &Incoming,
    lang: &str,
) -> Option<Response> {
    if request.path == "/__password" && request.method == Method::POST {
        return None;
    }
    let (Some(secret), Some(stored)) = (
        state.config.secret.as_deref(),
        entry.password_hash.as_deref(),
    ) else {
        // A password visibility without a password can't be opened: closed.
        return Some(password_page(lang, false));
    };
    let passed = cookie(&request.headers, PASS_COOKIE)
        .is_some_and(|pass| tokens::verify_pass(secret, host, stored, &pass));
    (!passed).then(|| password_page(lang, false))
}

/// `POST /__password`: the shop's password, form-encoded.
async fn password_submit(
    state: &EdgeState,
    entry: &HostEntry,
    host: &str,
    request: Request,
    lang: &str,
) -> Response {
    let (Some(secret), Some(stored)) = (state.config.secret.clone(), entry.password_hash.clone())
    else {
        return password_page(lang, false);
    };
    if request.method() != Method::POST {
        return password_page(lang, false);
    }
    let Ok(body) = to_bytes(request.into_body(), 16 * 1024).await else {
        return password_page(lang, true);
    };
    let password = url::form_urlencoded::parse(&body)
        .find(|(k, _)| k == "password")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if !tokens::check_password(&secret, &stored, &password) {
        return password_page(lang, true);
    }
    let Some(pass) = tokens::visitor_pass(&secret, host, &stored) else {
        return password_page(lang, true);
    };
    let secure_flag = if state.config.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    let mut response = redirect(StatusCode::SEE_OTHER, "/");
    if let Ok(value) = HeaderValue::from_str(&format!(
        "{PASS_COOKIE}={pass}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax{secure_flag}",
        tokens::PASS_SECONDS
    )) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

// ── The renderer ───────────────────────────────────────────────────────

/// Request headers passed to the renderer.
const FORWARDED: [&str; 10] = [
    "accept",
    "accept-language",
    "content-type",
    "cookie",
    "user-agent",
    "if-none-match",
    "if-modified-since",
    "referer",
    "origin",
    "next-action",
];

/// Response headers never passed back.
const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "content-length",
];

async fn proxy(
    state: &EdgeState,
    entry: &HostEntry,
    host: &str,
    incoming: Incoming,
    body: Body,
    previewing: bool,
) -> Response {
    let lang = language(&incoming.headers);
    let (Some(base), Some(client), Some(secret)) = (
        &state.renderer_url,
        &state.renderer,
        state.config.secret.as_deref(),
    ) else {
        return unavailable_page(lang);
    };
    let method = incoming.method.clone();
    let target = format!("{base}{}", incoming.path_and_query);
    let headers = incoming.headers;
    let shopper = limit::proxy_client(&headers, state.trusted_proxies);
    let Ok(body) = to_bytes(body, MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mut outbound = HttpRequest::empty(method.as_str(), target);
    for name in FORWARDED {
        for value in headers.get_all(name).iter().filter_map(|v| v.to_str().ok()) {
            outbound = outbound.header(name, value);
        }
    }
    let proto = if state.config.scheme() == "https" {
        "https"
    } else {
        "http"
    };
    outbound = outbound
        .header("x-storefront-edge", secret)
        .header("x-storefront-host", host)
        .header("x-storefront-site", &entry.site_id)
        .header("x-storefront-workspace", &entry.workspace_id)
        .header("x-storefront-channel", &entry.channel_id)
        .header(
            "x-storefront-version",
            entry.published_version_id.as_deref().unwrap_or("none"),
        )
        .header("x-forwarded-for", &shopper)
        .header("x-forwarded-proto", proto)
        .header("x-forwarded-host", host);
    if !body.is_empty() {
        outbound.body = Some(body.to_vec());
    }
    let answer = match client.send(outbound).await {
        Ok(answer) => answer,
        Err(error) => {
            tracing::error!(%error, "[storefront-edge] the renderer did not answer");
            return unavailable_page(lang);
        }
    };
    let mut response = Response::new(Body::from(answer.body));
    *response.status_mut() = StatusCode::from_u16(answer.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    for (name, value) in answer.headers {
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.append(name, value);
        }
    }
    if previewing && !state.editor_origins.is_empty() {
        let ancestors = format!("frame-ancestors 'self' {}", state.editor_origins.join(" "));
        if let Ok(value) = HeaderValue::from_str(&ancestors) {
            headers.append(header::CONTENT_SECURITY_POLICY, value);
        }
        headers.insert(
            HeaderName::from_static("x-robots-tag"),
            HeaderValue::from_static("noindex"),
        );
        secure(headers, false);
    } else {
        secure(headers, true);
    }
    if state.config.scheme() == "https" {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

// ── Static deployments ─────────────────────────────────────────────────

/// A deployment's manifest: its files and its `weldstorefront.json`.
#[derive(Debug, Default)]
struct Manifest {
    site_id: String,
    files: HashMap<String, (u64, String)>,
    spa: bool,
    clean_urls: bool,
    redirects: Vec<(String, String, u16)>,
    headers: Vec<(String, Vec<(String, String)>)>,
}

impl Manifest {
    fn parse(value: &Value) -> Self {
        let config = &value["config"];
        Self {
            site_id: value["siteId"].as_str().unwrap_or_default().to_owned(),
            files: value["files"]
                .as_object()
                .map(|files| {
                    files
                        .iter()
                        .map(|(path, info)| {
                            (
                                path.clone(),
                                (
                                    info["size"].as_u64().unwrap_or_default(),
                                    info["etag"].as_str().unwrap_or_default().to_owned(),
                                ),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            spa: config["spa"].as_bool().unwrap_or(false),
            clean_urls: config["cleanUrls"].as_bool().unwrap_or(true),
            redirects: config["redirects"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|r| {
                            Some((
                                r["from"].as_str()?.to_owned(),
                                r["to"].as_str()?.to_owned(),
                                u16::try_from(r["status"].as_u64().unwrap_or(301)).unwrap_or(301),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            headers: config["headers"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|rule| {
                            let source = rule["source"].as_str()?.to_owned();
                            let headers = rule["headers"]
                                .as_object()?
                                .iter()
                                .filter_map(|(k, v)| {
                                    Some((k.to_ascii_lowercase(), v.as_str()?.to_owned()))
                                })
                                .collect();
                            Some((source, headers))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// The file a path serves, and whether it is the "not found" answer.
    fn resolve(&self, path: &str) -> Option<(String, StatusCode)> {
        let relative = path.trim_start_matches('/');
        let mut candidates = Vec::new();
        if relative.is_empty() || relative.ends_with('/') {
            candidates.push(format!("{relative}index.html"));
        } else {
            candidates.push(relative.to_owned());
            if self.clean_urls {
                candidates.push(format!("{relative}.html"));
                candidates.push(format!("{relative}/index.html"));
            }
        }
        if let Some(found) = candidates.into_iter().find(|c| self.files.contains_key(c)) {
            return Some((found, StatusCode::OK));
        }
        let last = relative.rsplit('/').next().unwrap_or_default();
        if self.spa && !last.contains('.') && self.files.contains_key("index.html") {
            return Some(("index.html".to_owned(), StatusCode::OK));
        }
        self.files
            .contains_key("404.html")
            .then(|| ("404.html".to_owned(), StatusCode::NOT_FOUND))
    }

    fn redirect_for(&self, path: &str) -> Option<(String, u16)> {
        self.redirects
            .iter()
            .find(|(from, _, _)| from == path)
            .map(|(_, to, status)| (to.clone(), *status))
    }

    fn headers_for(&self, path: &str) -> Vec<(String, String)> {
        self.headers
            .iter()
            .filter(|(source, _)| {
                source == path
                    || source
                        .strip_suffix('*')
                        .is_some_and(|prefix| path.starts_with(prefix))
            })
            .flat_map(|(_, headers)| headers.clone())
            .collect()
    }
}

/// A file name with a content hash in it (`app-1a2b3c4d.js`), or one under
/// a bundler's asset folder: safe to cache for a year.
fn is_hashed(path: &str) -> bool {
    if path.starts_with("assets/")
        || path.starts_with("_astro/")
        || path.starts_with("_next/static/")
    {
        return true;
    }
    let name = path.rsplit('/').next().unwrap_or_default();
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.rsplit(['-', '.']).next().is_some_and(|tail| {
        tail.len() >= 8
            && tail.bytes().all(|b| b.is_ascii_alphanumeric())
            && tail.bytes().any(|b| b.is_ascii_digit())
    }) && stem.contains(['-', '.'])
}

fn cached_manifest(state: &EdgeState, deployment: &str) -> Option<Arc<Manifest>> {
    state
        .manifests
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(deployment)
        .map(Arc::clone)
}

fn remember_manifest(state: &EdgeState, deployment: &str, manifest: &Arc<Manifest>) {
    let mut cache = state
        .manifests
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if cache.len() >= MAX_MANIFESTS {
        cache.clear();
    }
    cache.insert(deployment.to_owned(), Arc::clone(manifest));
}

async fn manifest(
    state: &EdgeState,
    workspace_id: &str,
    deployment: &str,
) -> Option<Arc<Manifest>> {
    if let Some(found) = cached_manifest(state, deployment) {
        return Some(found);
    }
    let files = state.config.files.as_ref()?;
    let object = files
        .get_boxed(&format!("{}{MANIFEST}", prefix(workspace_id, deployment)))
        .await
        .ok()
        .flatten()?;
    let value: Value = serde_json::from_slice(&object.bytes).ok()?;
    if value["workspaceId"].as_str() != Some(workspace_id) {
        return None;
    }
    let parsed = Arc::new(Manifest::parse(&value));
    remember_manifest(state, deployment, &parsed);
    Some(parsed)
}

async fn preview_deployment(
    state: &EdgeState,
    request: &Incoming,
    deployment: &str,
    shop_host: &str,
    lang: &str,
) -> Response {
    let entry = match registry::lookup(&state.master, state.config.cache.as_ref(), shop_host).await
    {
        Ok(Some(entry)) => entry,
        Ok(None) => return missing(lang),
        Err(error) => {
            tracing::error!(%error, "[storefront-edge] host lookup failed");
            return unavailable_page(lang);
        }
    };
    let mut response = serve_static(
        state,
        request,
        &entry.workspace_id,
        &entry.site_id,
        deployment,
        true,
    )
    .await;
    response.headers_mut().insert(
        HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex"),
    );
    response
}

#[allow(
    clippy::too_many_lines,
    reason = "the manifest, redirects, the file and its headers in turn"
)]
async fn serve_static(
    state: &EdgeState,
    request: &Incoming,
    workspace_id: &str,
    site_id: &str,
    deployment: &str,
    preview: bool,
) -> Response {
    let lang = language(&request.headers);
    if !matches!(request.method, Method::GET | Method::HEAD) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(manifest) = manifest(state, workspace_id, deployment).await else {
        return missing(lang);
    };
    if manifest.site_id != site_id {
        return missing(lang);
    }
    let raw_path = request.path.as_str();
    let path = percent_decode(raw_path).unwrap_or_else(|| raw_path.to_owned());
    if let Some((to, status)) = manifest.redirect_for(&path) {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::MOVED_PERMANENTLY);
        return redirect(status, &to);
    }
    let Some((file, status)) = manifest.resolve(&path) else {
        return missing(lang);
    };
    let etag = manifest
        .files
        .get(&file)
        .map(|(_, etag)| format!("\"{etag}\""))
        .unwrap_or_default();
    let if_none_match = request
        .headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    let cache_control = if is_hashed(&file) {
        "public, max-age=31536000, immutable"
    } else if std::path::Path::new(&file)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html"))
    {
        "no-cache"
    } else {
        "public, max-age=3600"
    };
    let mut response = if status == StatusCode::OK
        && !etag.is_empty()
        && if_none_match.is_some_and(|tags| {
            tags.split(',')
                .any(|t| t.trim().trim_start_matches("W/") == etag)
        }) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let Some(files) = state.config.files.as_ref() else {
            return unavailable_page(lang);
        };
        let object = match files
            .get_boxed(&format!("{}{file}", prefix(workspace_id, deployment)))
            .await
        {
            Ok(Some(object)) => object,
            Ok(None) => return missing(lang),
            Err(error) => {
                tracing::error!(%error, "[storefront-edge] a deployment file could not be read");
                return unavailable_page(lang);
            }
        };
        let body = if request.method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(Bytes::from(object.bytes))
        };
        let mut response = Response::new(body);
        *response.status_mut() = status;
        if let Ok(value) = HeaderValue::from_str(content_type(&file)) {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        response
    };
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    for (name, value) in manifest.headers_for(&path) {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }
    secure(
        headers,
        !preview && !headers.contains_key(header::CONTENT_SECURITY_POLICY),
    );
    if state.config.scheme() == "https" {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

/// `%xx` decoded; `None` for an invalid sequence or a NUL.
fn percent_decode(path: &str) -> Option<String> {
    let decoded = url::form_urlencoded::parse(format!("p={}", path.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())?;
    (!decoded.contains('\0')).then_some(decoded)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn manifest(spa: bool) -> Manifest {
        Manifest::parse(&json!({
            "siteId": "sfs_1",
            "config": {
                "spa": spa,
                "redirects": [{ "from": "/old", "to": "/new", "status": 302 }],
                "headers": [{ "source": "/assets/*", "headers": { "Cache-Control": "public, max-age=60" } }]
            },
            "files": {
                "index.html": { "size": 10, "etag": "aa" },
                "about.html": { "size": 10, "etag": "bb" },
                "docs/index.html": { "size": 10, "etag": "cc" },
                "404.html": { "size": 10, "etag": "dd" },
                "assets/app-1a2b3c4d.js": { "size": 10, "etag": "ee" }
            }
        }))
    }

    #[test]
    fn paths_resolve_with_clean_urls_and_fallbacks() {
        let m = manifest(false);
        assert_eq!(
            m.resolve("/"),
            Some(("index.html".to_owned(), StatusCode::OK))
        );
        assert_eq!(
            m.resolve("/about"),
            Some(("about.html".to_owned(), StatusCode::OK))
        );
        assert_eq!(
            m.resolve("/docs"),
            Some(("docs/index.html".to_owned(), StatusCode::OK))
        );
        assert_eq!(
            m.resolve("/docs/"),
            Some(("docs/index.html".to_owned(), StatusCode::OK))
        );
        assert_eq!(
            m.resolve("/nope"),
            Some(("404.html".to_owned(), StatusCode::NOT_FOUND))
        );
        let spa = manifest(true);
        assert_eq!(
            spa.resolve("/products/shoe"),
            Some(("index.html".to_owned(), StatusCode::OK))
        );
        assert_eq!(
            spa.resolve("/missing.js"),
            Some(("404.html".to_owned(), StatusCode::NOT_FOUND))
        );
    }

    #[test]
    fn redirects_and_headers_from_the_config() {
        let m = manifest(false);
        assert_eq!(m.redirect_for("/old"), Some(("/new".to_owned(), 302)));
        assert_eq!(
            m.headers_for("/assets/app.js"),
            vec![("cache-control".to_owned(), "public, max-age=60".to_owned())]
        );
        assert_eq!(m.headers_for("/index.html"), Vec::<(String, String)>::new());
    }

    #[test]
    fn hashed_files() {
        assert!(is_hashed("assets/index-BxT3a9Qz.js"));
        assert!(is_hashed("main.4f3a9c21b7.css"));
        assert!(!is_hashed("index.html"));
        assert!(!is_hashed("favicon.ico"));
        assert!(!is_hashed("about-us.html"));
    }

    #[test]
    fn languages() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("nl-NL,nl;q=0.9,en;q=0.8"),
        );
        assert_eq!(language(&headers), "nl");
        headers.insert(header::ACCEPT_LANGUAGE, HeaderValue::from_static("es-ES"));
        assert_eq!(language(&headers), "en");
    }

    #[test]
    fn cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; wsf_pass=x.y.z; b=2"),
        );
        assert_eq!(cookie(&headers, PASS_COOKIE).as_deref(), Some("x.y.z"));
        assert_eq!(cookie(&headers, PREVIEW_COOKIE), None);
    }
}
