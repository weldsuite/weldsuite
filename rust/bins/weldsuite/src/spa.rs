//! The platform SPA from the same origin as the API (`SPA_DIR`), for the
//! Kubernetes editions (ADR OPS-013): the image carries the platform's Vite
//! build, made with `VITE_RUNTIME_CONFIG=on`, so the app reads `/config.json`
//! and calls the API on its own origin.
//!
//! The SPA is the root router's fallback and nothing else, so every route
//! the server has keeps precedence: `/api`, `/config.json`, the probes. It
//! answers `GET` and `HEAD` for any other path, as Cloudflare Pages serves
//! the Global build:
//!
//! - a file of the build: its content type, a precompressed `.br` or `.gz`
//!   next to it when the client accepts one, `Last-Modified`, ranges;
//! - `/`, or a path with no file (a client route): `index.html`, revalidated
//!   on every load (`no-cache`, an `ETag` of its content), so a release
//!   reaches every tab on its next navigation;
//! - a path with no file under a directory that has a `404.html` (the
//!   platform's `assets/404.html`): that page with a 404, so a stale tab
//!   asking for an old chunk gets an error, not HTML it would run as a
//!   script;
//! - headers: the rules of the build's `_headers` file (Pages' format), then
//!   the defaults: `/assets/*` (Vite's content-hashed output) cached for a
//!   year, everything else `no-cache`, `nosniff`. Error pages `no-store`.
//!
//! Other methods, and paths under `/api` or `/public` (the backend's), get
//! the API's JSON 404 instead.

use std::collections::HashMap;
use std::fmt;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeDir;
use weldsuite_kit::ApiError;

/// Paths the backend owns even where it has no route: never the SPA.
/// The realtime gateway's are here too, so a socket never gets `index.html`
/// when the gateway is off.
const BACKEND_PREFIXES: [&str; 5] = ["/api", "/public", "/ws", "/publish", "/internal"];

/// Cloudflare Pages' own files: configuration, never served.
const PAGES_FILES: [&str; 2] = ["/_headers", "/_redirects"];

/// Vite's output directory: every file in it is named by its content hash.
const HASHED_PREFIX: &str = "/assets/";

const IMMUTABLE: HeaderValue = HeaderValue::from_static("public, max-age=31536000, immutable");
const REVALIDATE: HeaderValue = HeaderValue::from_static("no-cache");
const NO_STORE: HeaderValue = HeaderValue::from_static("no-store");
const HTML: HeaderValue = HeaderValue::from_static("text/html; charset=utf-8");

/// Directories deeper than this are not searched for `404.html` pages.
const MAX_DEPTH: usize = 16;

/// Why `SPA_DIR` cannot be served.
#[derive(Debug)]
pub(crate) struct SpaError(String);

impl fmt::Display for SpaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SpaError {}

/// A built SPA on disk, read once at start except for its files.
pub(crate) struct Spa {
    root: PathBuf,
    files: ServeDir,
    index: Bytes,
    index_etag: HeaderValue,
    /// `404.html` pages by their directory (`""` for the root, `assets`, …).
    not_found_pages: HashMap<String, Bytes>,
    rules: Vec<HeaderRule>,
}

impl fmt::Debug for Spa {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Spa")
            .field("root", &self.root)
            .field("rules", &self.rules.len())
            .finish_non_exhaustive()
    }
}

impl Spa {
    /// The build in `root`: it must have an `index.html`.
    pub(crate) fn load(root: &Path) -> Result<Self, SpaError> {
        let problem = |what: String| SpaError(format!("SPA_DIR {}: {what}", root.display()));
        let index = std::fs::read(root.join("index.html"))
            .map_err(|error| problem(format!("cannot read index.html: {error}")))?;
        let rules = match std::fs::read_to_string(root.join("_headers")) {
            Ok(text) => {
                parse_headers_file(&text).map_err(|error| problem(format!("_headers: {error}")))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(problem(format!("cannot read _headers: {error}"))),
        };
        let mut not_found_pages = HashMap::new();
        find_not_found_pages(root, "", 0, &mut not_found_pages)
            .map_err(|error| problem(format!("cannot list the files: {error}")))?;
        Ok(Self {
            root: root.to_owned(),
            files: ServeDir::new(root)
                .append_index_html_on_directories(false)
                .precompressed_br()
                .precompressed_gzip(),
            index_etag: content_etag(&index),
            index: Bytes::from(index),
            not_found_pages,
            rules,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    async fn respond(&self, request: Request) -> Response {
        let path = request.uri().path().to_owned();
        let conditions = request.headers().clone();
        if path == "/" || path == "/index.html" {
            return self.index(&path, &conditions);
        }
        if !PAGES_FILES.contains(&path.as_str()) {
            let response = match self.files.clone().oneshot(request).await {
                Ok(response) => response.map(Body::new),
                Err(never) => match never {},
            };
            match response.status() {
                StatusCode::NOT_FOUND => {}
                status if status.is_success() || status == StatusCode::NOT_MODIFIED => {
                    return self.with_headers(&path, response);
                }
                _ => return no_store(response),
            }
        }
        if let Some(page) = self.not_found_page(&path) {
            return no_store(
                (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, HTML)], page).into_response(),
            );
        }
        self.index(&path, &conditions)
    }

    /// `index.html`, from memory, for `path`.
    fn index(&self, path: &str, conditions: &HeaderMap) -> Response {
        let fresh = conditions
            .get(header::IF_NONE_MATCH)
            .is_some_and(|value| etag_matches(value, &self.index_etag));
        let mut response = if fresh {
            StatusCode::NOT_MODIFIED.into_response()
        } else {
            ([(header::CONTENT_TYPE, HTML)], self.index.clone()).into_response()
        };
        response
            .headers_mut()
            .insert(header::ETAG, self.index_etag.clone());
        self.with_headers(path, response)
    }

    /// The nearest `404.html` above a path with no file, if the build has one.
    fn not_found_page(&self, path: &str) -> Option<Bytes> {
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let (_, directories) = segments.split_last()?;
        (0..=directories.len())
            .rev()
            .find_map(|depth| self.not_found_pages.get(&directories[..depth].join("/")))
            .cloned()
    }

    /// The `_headers` rules for `path`, then the defaults.
    fn with_headers(&self, path: &str, mut response: Response) -> Response {
        let headers = response.headers_mut();
        let mut detached = Vec::new();
        let mut combined: Vec<(HeaderName, String)> = Vec::new();
        for rule in self
            .rules
            .iter()
            .filter(|rule| glob(rule.pattern.as_bytes(), path.as_bytes()))
        {
            for (name, value) in &rule.set {
                match combined.iter_mut().find(|(known, _)| known == name) {
                    // Pages joins a header set by several rules.
                    Some((_, joined)) => {
                        joined.push_str(", ");
                        joined.push_str(value);
                    }
                    None => combined.push((name.clone(), value.clone())),
                }
            }
            detached.extend(rule.detach.iter().cloned());
        }
        for (name, value) in combined {
            if let Ok(value) = HeaderValue::from_str(&value) {
                headers.insert(name, value);
            }
        }
        if !headers.contains_key(header::CACHE_CONTROL) {
            let policy = if path.starts_with(HASHED_PREFIX) {
                IMMUTABLE
            } else {
                REVALIDATE
            };
            headers.insert(header::CACHE_CONTROL, policy);
        }
        if !headers.contains_key(header::X_CONTENT_TYPE_OPTIONS) {
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
        }
        for name in detached {
            headers.remove(name);
        }
        response
    }
}

/// Serve `spa` for what `app` has no route for. Without one, `app` as it is.
///
/// The SPA replaces the root router's fallback after its layers, so it gets
/// none of them (tracing, CORS, the app context): static files need none,
/// and a span per chunk would drown the API's traces. It keeps the request
/// id.
pub(crate) fn mount(app: Router, spa: Option<Arc<Spa>>) -> Router {
    let Some(spa) = spa else {
        return app;
    };
    app.fallback_service(
        Router::new()
            .fallback(serve)
            .with_state(spa)
            .layer(axum::middleware::from_fn(weldsuite_kit::request_id)),
    )
}

async fn serve(State(spa): State<Arc<Spa>>, request: Request) -> Response {
    let method = request.method();
    let path = request.uri().path();
    let backend = BACKEND_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if backend || (method != Method::GET && method != Method::HEAD) {
        // The root router's own answer: `{ error: { code: 'NOT_FOUND', … } }`.
        return ApiError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            format!("{path} not found"),
        )
        .into_response();
    }
    spa.respond(request).await
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, NO_STORE);
    response
}

/// A strong `ETag` of `content`; it only has to change when the content does.
fn content_etag(content: &[u8]) -> HeaderValue {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    HeaderValue::from_str(&format!("\"{:016x}-{:x}\"", hasher.finish(), content.len()))
        .unwrap_or(HeaderValue::from_static("\"index\""))
}

/// `If-None-Match` against our tag: `*`, or a list of tags compared weakly.
fn etag_matches(condition: &HeaderValue, etag: &HeaderValue) -> bool {
    let Ok(condition) = condition.to_str() else {
        return false;
    };
    let ours = etag.to_str().unwrap_or_default();
    condition
        .split(',')
        .map(str::trim)
        .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == ours)
}

/// Every `404.html` under `dir`, keyed by its directory relative to the root.
fn find_not_found_pages(
    dir: &Path,
    relative: &str,
    depth: usize,
    pages: &mut HashMap<String, Bytes>,
) -> std::io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            let child = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            find_not_found_pages(&entry.path(), &child, depth + 1, pages)?;
        } else if kind.is_file() && name == "404.html" {
            pages.insert(
                relative.to_owned(),
                Bytes::from(std::fs::read(entry.path())?),
            );
        }
    }
    Ok(())
}

/// One rule of a `_headers` file: a path pattern and what it does to the
/// headers.
#[derive(Debug, PartialEq, Eq)]
struct HeaderRule {
    /// `/assets/*`: `*` matches anything, `:name` one path segment.
    pattern: String,
    set: Vec<(HeaderName, String)>,
    /// `! Name` lines: headers removed, defaults included.
    detach: Vec<HeaderName>,
}

/// Cloudflare Pages' `_headers` format: a path pattern on its own line, then
/// its headers indented below it, `#` comments. Rules for absolute URLs (a
/// host) are skipped: they only mean something on Pages.
fn parse_headers_file(text: &str) -> Result<Vec<HeaderRule>, String> {
    let mut rules: Vec<HeaderRule> = Vec::new();
    // `false` while inside a skipped rule.
    let mut current = false;
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            current = trimmed.starts_with('/');
            if current {
                rules.push(HeaderRule {
                    pattern: trimmed.to_owned(),
                    set: Vec::new(),
                    detach: Vec::new(),
                });
            } else {
                tracing::warn!(
                    line = number,
                    rule = trimmed,
                    "_headers: only path rules apply here; skipped"
                );
            }
            continue;
        }
        if !current {
            if rules.is_empty() {
                return Err(format!("line {number}: a header before any path"));
            }
            continue;
        }
        let Some(rule) = rules.last_mut() else {
            return Err(format!("line {number}: a header before any path"));
        };
        if let Some(name) = trimmed.strip_prefix('!') {
            let name = HeaderName::from_bytes(name.trim().as_bytes())
                .map_err(|_| format!("line {number}: not a header name: {name}"))?;
            rule.detach.push(name);
            continue;
        }
        let (name, value) = trimmed
            .split_once(':')
            .ok_or_else(|| format!("line {number}: expected `Name: value`"))?;
        let name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| format!("line {number}: not a header name: {name}"))?;
        let value = value.trim();
        HeaderValue::from_str(value)
            .map_err(|_| format!("line {number}: not a header value: {value}"))?;
        rule.set.push((name, value.to_owned()));
    }
    Ok(rules)
}

/// `_headers` pattern matching: `*` matches any run of characters, `:name`
/// one or more characters of a single path segment.
fn glob(pattern: &[u8], path: &[u8]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((b'*', rest)) => (0..=path.len()).any(|skip| glob(rest, &path[skip..])),
        Some((b':', after))
            if after
                .first()
                .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') =>
        {
            let name = after
                .iter()
                .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_')
                .count();
            let rest = &after[name..];
            let segment = path.iter().take_while(|c| **c != b'/').count();
            (1..=segment).any(|take| glob(rest, &path[take..]))
        }
        Some((first, rest)) => path.first() == Some(first) && glob(rest, &path[1..]),
    }
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use serde_json::json;

    use super::*;

    /// A build like the platform's, in a fresh temporary directory.
    struct Build(PathBuf);

    impl Build {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("weldsuite-spa-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let write = |path: &str, content: &[u8]| {
                let path = root.join(path);
                std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
                std::fs::write(path, content).expect("write");
            };
            write("index.html", b"<!doctype html><title>WeldSuite</title>");
            write("assets/app-Dk3x9aQe.js", b"console.log('app')");
            write("assets/app-Dk3x9aQe.js.br", b"brotli bytes");
            write("assets/404.html", b"<p>Asset not found.</p>");
            write("favicon.ico", b"icon");
            write("models/box/model.json", b"{}");
            write(
                "_headers",
                b"# Pages rules\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/index.html\n  Cache-Control: no-cache\n\n/w9/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  Cache-Control: no-store\n\nhttps://example.pages.dev/*\n  X-Robots-Tag: noindex\n",
            );
            Self(root)
        }

        fn spa(&self) -> Arc<Spa> {
            Arc::new(Spa::load(&self.0).expect("load"))
        }
    }

    impl Drop for Build {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn root_not_found(
        axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    ) -> ApiError {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            format!("{} not found", uri.path()),
        )
    }

    /// The server's shape: explicit routes, `/api` with its own fallback,
    /// the root's JSON 404 and layers.
    fn app() -> Router {
        Router::new()
            .route(
                "/config.json",
                get(|| async { Json(json!({ "backend": "rust" })) }),
            )
            .route("/livez", get(|| async { "ok" }))
            .nest(
                "/api",
                Router::new()
                    .route("/me", get(|| async { "me" }))
                    .fallback(root_not_found),
            )
            .fallback(root_not_found)
            .layer(axum::middleware::from_fn(weldsuite_kit::request_id))
    }

    struct Answer {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    impl Answer {
        fn header(&self, name: &str) -> &str {
            self.headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
        }
    }

    async fn call(app: Router, method: &str, path: &str, headers: &[(&str, &str)]) -> Answer {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        Answer {
            status,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        }
    }

    async fn fetch(spa: &Arc<Spa>, path: &str) -> Answer {
        call(mount(app(), Some(Arc::clone(spa))), "GET", path, &[]).await
    }

    #[tokio::test]
    async fn the_root_and_client_routes_get_index_html_revalidated() {
        let build = Build::new("index");
        let spa = build.spa();
        for path in [
            "/",
            "/index.html",
            "/weldcrm/contacts",
            "/weldhost/domains/example.com",
            "/_headers",
        ] {
            let answer = fetch(&spa, path).await;
            assert_eq!(answer.status, StatusCode::OK, "{path}");
            assert_eq!(
                answer.body, "<!doctype html><title>WeldSuite</title>",
                "{path}"
            );
            assert_eq!(answer.header("content-type"), "text/html; charset=utf-8");
            assert_eq!(answer.header("cache-control"), "no-cache", "{path}");
            assert_eq!(answer.header("x-content-type-options"), "nosniff");
            assert!(answer.headers.contains_key("x-request-id"), "{path}");
        }
        let etag = fetch(&spa, "/").await.header("etag").to_owned();
        assert!(etag.starts_with('"'), "{etag}");

        let app = mount(app(), Some(Arc::clone(&spa)));
        let answer = call(app.clone(), "GET", "/weldcrm", &[("if-none-match", &etag)]).await;
        assert_eq!(answer.status, StatusCode::NOT_MODIFIED);
        assert_eq!(answer.body, "");
        assert_eq!(answer.header("etag"), etag);
        let answer = call(app.clone(), "GET", "/", &[("if-none-match", "\"stale\"")]).await;
        assert_eq!(answer.status, StatusCode::OK);
        let answer = call(app, "HEAD", "/weldcrm", &[]).await;
        assert_eq!((answer.status, answer.body.as_str()), (StatusCode::OK, ""));
    }

    #[tokio::test]
    async fn hashed_assets_are_immutable_and_precompressed() {
        let build = Build::new("assets");
        let spa = build.spa();
        let answer = fetch(&spa, "/assets/app-Dk3x9aQe.js").await;
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.body, "console.log('app')");
        assert!(
            answer.header("content-type").contains("javascript"),
            "{}",
            answer.header("content-type")
        );
        assert_eq!(
            answer.header("cache-control"),
            "public, max-age=31536000, immutable"
        );
        assert!(answer.headers.contains_key("last-modified"));

        let app = mount(app(), Some(Arc::clone(&spa)));
        let answer = call(
            app,
            "GET",
            "/assets/app-Dk3x9aQe.js",
            &[("accept-encoding", "gzip, br")],
        )
        .await;
        assert_eq!(answer.header("content-encoding"), "br");
        assert_eq!(answer.body, "brotli bytes");
        assert!(
            answer
                .header("vary")
                .to_ascii_lowercase()
                .contains("accept-encoding")
        );

        // Not under /assets: revalidated.
        let answer = fetch(&spa, "/favicon.ico").await;
        assert_eq!(
            (answer.status, answer.header("cache-control")),
            (StatusCode::OK, "no-cache")
        );
        let answer = fetch(&spa, "/models/box/model.json").await;
        assert_eq!(answer.header("content-type"), "application/json");
    }

    #[tokio::test]
    async fn a_missing_asset_is_a_404_never_index_html() {
        let build = Build::new("missing");
        let spa = build.spa();
        for path in ["/assets/app-OldHash1.js", "/assets/deep/er/chunk.css"] {
            let answer = fetch(&spa, path).await;
            assert_eq!(answer.status, StatusCode::NOT_FOUND, "{path}");
            assert_eq!(answer.body, "<p>Asset not found.</p>");
            assert_eq!(answer.header("cache-control"), "no-store");
        }
    }

    #[tokio::test]
    async fn header_rules_apply_by_request_path() {
        let build = Build::new("rules");
        let spa = build.spa();
        let answer = fetch(&spa, "/w9/tok_123").await;
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.header("x-robots-tag"), "noindex, nofollow");
        assert_eq!(answer.header("referrer-policy"), "no-referrer");
        assert_eq!(answer.header("cache-control"), "no-store");
        // The host rule only means something on Pages.
        assert_eq!(fetch(&spa, "/").await.header("x-robots-tag"), "");
    }

    #[tokio::test]
    async fn the_api_and_explicit_routes_keep_precedence() {
        let build = Build::new("precedence");
        let spa = build.spa();
        let answer = fetch(&spa, "/config.json").await;
        assert_eq!(answer.body, r#"{"backend":"rust"}"#);
        assert_eq!(fetch(&spa, "/livez").await.body, "ok");
        assert_eq!(fetch(&spa, "/api/me").await.body, "me");
        for path in [
            "/api",
            "/api/nope",
            "/public/sign-portal/session",
            "/public",
        ] {
            let answer = fetch(&spa, path).await;
            assert_eq!(answer.status, StatusCode::NOT_FOUND, "{path}");
            assert_eq!(
                answer.body,
                format!(r#"{{"error":{{"code":"NOT_FOUND","message":"{path} not found"}}}}"#)
            );
        }
        // Only GET and HEAD reach the files.
        let answer = call(mount(app(), Some(spa)), "POST", "/weldcrm", &[]).await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND);
        assert!(
            answer.body.contains("/weldcrm not found"),
            "{}",
            answer.body
        );
    }

    #[tokio::test]
    async fn nothing_outside_the_build_is_served() {
        let build = Build::new("traversal");
        // Next to the build, one directory up.
        let name = format!("weldsuite-spa-{}-secret.txt", std::process::id());
        let secret = build.0.parent().expect("parent").join(&name);
        std::fs::write(&secret, "TOP-SECRET").expect("write");
        let spa = build.spa();
        for path in [
            format!("/../{name}"),
            format!("/assets/../../{name}"),
            format!("/assets/..%2f..%2f{name}"),
            format!("/assets/%2e%2e/%2e%2e/{name}"),
        ] {
            let answer = fetch(&spa, &path).await;
            assert!(
                !answer.body.contains("TOP-SECRET"),
                "{path}: {}",
                answer.body
            );
        }
        let _ = std::fs::remove_file(secret);
    }

    #[tokio::test]
    async fn without_a_build_the_router_is_unchanged() {
        let answer = call(mount(app(), None), "GET", "/", &[]).await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND);
        assert_eq!(
            answer.body,
            r#"{"error":{"code":"NOT_FOUND","message":"/ not found"}}"#
        );
    }

    #[test]
    fn a_build_needs_an_index() {
        let root = std::env::temp_dir().join(format!("weldsuite-spa-{}-empty", std::process::id()));
        std::fs::create_dir_all(&root).expect("mkdir");
        let error = Spa::load(&root).expect_err("no index.html");
        assert!(error.to_string().contains("index.html"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn headers_files_parse_like_pages() {
        let rules =
            parse_headers_file("# comment\n/a/*\n  X-One: 1\n  ! X-Two\n/b/:id\n\tX-Three: 3\n")
                .expect("rules");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "/a/*");
        assert_eq!(
            rules[0].set,
            vec![(HeaderName::from_static("x-one"), "1".to_owned())]
        );
        assert_eq!(rules[0].detach, vec![HeaderName::from_static("x-two")]);
        assert_eq!(rules[1].set.len(), 1);

        assert!(parse_headers_file("  X-One: 1\n").is_err());
        assert!(parse_headers_file("/a\n  no colon\n").is_err());
        assert!(parse_headers_file("/a\n  Bad Name: 1\n").is_err());
    }

    #[test]
    fn patterns_match_splats_and_placeholders() {
        let matches = |pattern: &str, path: &str| glob(pattern.as_bytes(), path.as_bytes());
        assert!(matches("/assets/*", "/assets/app.js"));
        assert!(matches("/assets/*", "/assets/a/b.js"));
        assert!(!matches("/assets/*", "/asset/app.js"));
        assert!(matches("/", "/"));
        assert!(!matches("/", "/x"));
        assert!(matches("/w9/:token", "/w9/abc"));
        assert!(!matches("/w9/:token", "/w9/abc/def"));
        assert!(!matches("/w9/:token", "/w9/"));
        assert!(matches("/*.js", "/a/b.js"));
    }

    #[test]
    fn etags_compare_weakly_and_star_matches() {
        let ours = HeaderValue::from_static("\"abc-1\"");
        let check =
            |condition: &'static str| etag_matches(&HeaderValue::from_static(condition), &ours);
        assert!(check("\"abc-1\""));
        assert!(check("W/\"abc-1\""));
        assert!(check("\"x\", \"abc-1\""));
        assert!(check("*"));
        assert!(!check("\"abc-2\""));
    }
}
