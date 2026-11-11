//! The WeldDesk BI feed (`routes/v1/odata/index.ts`): an `OData` 4.0 service
//! (read-only) on the public API, `GET /v1/odata/…`, scope `reports:read`,
//! so Power BI and Excel can read helpdesk data.
//!
//! ```text
//!   GET /v1/odata/                 service document
//!   GET /v1/odata/$metadata        CSDL
//!   GET /v1/odata/<Set>            rows ($top $skip $skiptoken $select $orderby $filter $count $format)
//!   GET /v1/odata/<Set>/$count     number of rows, text/plain
//!   GET /v1/odata/<Set>('<key>')   one row
//! ```
//!
//! Writes answer 405, valid `OData` that is not served (`$expand`, `$apply`,
//! other functions, navigation) 501, a malformed request 400. The sets, their
//! properties and everything that is checked against them are in the
//! catalogue (`catalog.rs`, exported from TypeScript); the payloads are `OData`
//! 4.0 JSON with minimal metadata, written as the worker's `JSON.stringify`
//! writes them. The key layer accepts HTTP Basic (the password is the API
//! key) on this path only (`auth.rs`), because that is what Power BI's
//! connector offers.
//!
//! The layers, outermost first, as the worker runs them: `OData-Version` on
//! every answer and the 405 for a write (after the key layer, so a missing
//! key is still a 401), then the scope.

mod catalog;
mod error;
mod filter;
mod metadata;
mod query;
mod sql;

use axum::Router;
use axum::extract::{OriginalUri, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, any};
use http::header::{ALLOW, CONTENT_TYPE, HOST};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use weldsuite_core_domain::js::{Js, stringify};
use weldsuite_db::{PgPool, Tenant};

use self::catalog::find_entity_set;
use self::error::{ODataError, code_of};
use self::metadata::{context_url, metadata_xml, next_link, service_document};
use self::query::{ReadError, Surface, count_rows, fetch_entity, fetch_page, parse_query_options};
use crate::ExternalApiState;
use crate::session::{database_error, internal, require_scope};

/// `ODATA_READ_SCOPE`.
const READ_SCOPE: &str = "reports:read";
const JSON_TYPE: &str = "application/json;odata.metadata=minimal";
const ROOT_PATH: &str = "/v1/odata";
const WRITE_ALLOW: &str = "GET, HEAD, OPTIONS";
const ODATA_VERSION: HeaderName = HeaderName::from_static("odata-version");

/// The worker's routes: everything at and below `/v1/odata`.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    mount(router)
}

fn mount<S>(router: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router
        .route("/odata", feed())
        .route("/odata/", feed())
        .route("/odata/{*path}", feed())
}

fn feed<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    // `any` answers every method, so the layers go around all of it.
    any(handle)
        .layer(axum::middleware::from_fn_with_state(
            READ_SCOPE,
            require_scope,
        ))
        .layer(axum::middleware::from_fn(read_only))
}

fn respond(status: StatusCode, content_type: &'static str, body: String) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(ODATA_VERSION, HeaderValue::from_static("4.0"));
    response
}

/// `jsonResponse(c, payload, status)`.
fn json(status: StatusCode, body: String) -> Response {
    respond(status, JSON_TYPE, body)
}

/// Read-only: anything that would write is a 405. Every answer of the feed,
/// a refusal of the scope included, carries `OData-Version`.
async fn read_only(request: Request, next: Next) -> Response {
    let mut response = if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        next.run(request).await
    } else {
        let status = StatusCode::METHOD_NOT_ALLOWED;
        let mut response = json(
            status,
            ODataError::new(status, "The OData feed is read-only.").body(),
        );
        response
            .headers_mut()
            .insert(ALLOW, HeaderValue::from_static(WRITE_ALLOW));
        response
    };
    response
        .headers_mut()
        .insert(ODATA_VERSION, HeaderValue::from_static("4.0"));
    response
}

/// Why a request was not answered with its data.
enum Failure {
    OData(ODataError),
    Read(ReadError),
}

impl From<ODataError> for Failure {
    fn from(error: ODataError) -> Self {
        Self::OData(error)
    }
}

impl From<ReadError> for Failure {
    fn from(error: ReadError) -> Self {
        Self::Read(error)
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Self::OData(error) => {
                debug_assert_eq!(error.code(), code_of(error.status));
                json(error.status, error.body())
            }
            // What the worker's error handler answers anything it did not expect with.
            Self::Read(ReadError::Database(error)) => database_error(&error).into_response(),
            Self::Read(ReadError::Unreadable) => {
                tracing::error!("external-api: an OData row or catalogue entry could not be read");
                internal().into_response()
            }
        }
    }
}

/// `decodeURIComponent(text)`: `None` where JavaScript throws (a `%` without
/// two hex digits, or escapes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let hex = |byte: Option<&u8>| byte.and_then(|b| char::from(*b).to_digit(16));
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut escaped: Vec<u8> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let (high, low) = (hex(bytes.get(index + 1))?, hex(bytes.get(index + 2))?);
            escaped.push(u8::try_from(high * 16 + low).ok()?);
            index += 3;
            continue;
        }
        // A run of escapes is one or more whole characters.
        out.push_str(std::str::from_utf8(&escaped).ok()?);
        escaped.clear();
        let ch = text[index..].chars().next()?;
        out.push(ch);
        index += ch.len_utf8();
    }
    out.push_str(std::str::from_utf8(&escaped).ok()?);
    Some(out)
}

/// `pathSegments(c)`: what follows `/v1/odata`, split and decoded.
fn path_segments(path: &str) -> Result<Vec<String>, ODataError> {
    let rest = path
        .find(ROOT_PATH)
        .map_or("", |index| &path[index + ROOT_PATH.len()..]);
    rest.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            decode_uri_component(segment)
                .ok_or_else(|| ODataError::bad_request("The path is not valid percent-encoding"))
        })
        .collect()
}

/// `parseSegment(segment)`: `Conversations`, `Conversations('abc')` (with
/// `''` for a quote) or `Conversations()`: the set's name and the key.
fn parse_segment(segment: &str) -> Result<(&str, Option<String>), ODataError> {
    let not_found = || ODataError::not_found(format!("Resource not found: {segment}"));
    let length = segment
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    let (name, rest) = segment.split_at(length);
    if name.is_empty() {
        return Err(not_found());
    }
    if rest.is_empty() {
        return Ok((name, None));
    }
    let inner = rest
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
        .ok_or_else(not_found)?;
    if inner.is_empty() {
        return Ok((name, None));
    }
    let quoted = inner
        .strip_prefix('\'')
        .and_then(|inner| inner.strip_suffix('\''))
        // Inside the quotes a quote is written twice.
        .filter(|inner| inner.split("''").all(|part| !part.contains('\'')))
        .ok_or_else(|| {
            ODataError::bad_request(
                "A key must be a string in single quotes, like Conversations('cnv_1')",
            )
        })?;
    Ok((name, Some(quoted.replace("''", "'"))))
}

/// The request's origin as the client reached it (`new URL(c.req.url).origin`):
/// `X-Forwarded-Proto` and `X-Forwarded-Host` from the ingress, else the
/// `Host` header over HTTP.
fn request_origin(headers: &HeaderMap) -> String {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let host = header("x-forwarded-host")
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("localhost");
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    // `new URL(...).origin` drops a default port.
    let host = match (scheme, host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name,
        _ => host,
    };
    format!("{scheme}://{}", host.to_ascii_lowercase())
}

/// `app.all('*')`: every path of the feed.
async fn handle(request: Request) -> Response {
    let uri = request
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| request.uri().clone(), |original| original.0.clone());
    let origin = request_origin(request.headers());
    let db = request
        .extensions()
        .get::<Tenant>()
        .map(|tenant| tenant.db.clone());
    drop(request);
    match answer(uri.path(), uri.query(), &origin, db).await {
        Ok(response) => response,
        Err(failure) => failure.into_response(),
    }
}

/// `handle(c)`.
async fn answer(
    path: &str,
    query: Option<&str>,
    origin: &str,
    db: Option<PgPool>,
) -> Result<Response, Failure> {
    let root = format!("{origin}{ROOT_PATH}");
    let segments = path_segments(path)?;

    let Some(first) = segments.first() else {
        return Ok(json(StatusCode::OK, stringify(&service_document(&root))));
    };
    if first == "$metadata" && segments.len() == 1 {
        return Ok(respond(
            StatusCode::OK,
            "application/xml",
            metadata_xml().to_owned(),
        ));
    }

    let (name, key) = parse_segment(first)?;
    let set = find_entity_set(name)
        .ok_or_else(|| ODataError::not_found(format!("The entity set '{name}' does not exist")))?;
    // `url.searchParams`: the pairs, decoded, in the order given.
    let params: Vec<(String, String)> =
        form_urlencoded::parse(query.unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    // The key layer gave the tenant database with the session.
    let db = || db.clone().ok_or(ReadError::Unreadable);

    if segments.len() == 2 && segments[1] == "$count" && key.is_none() {
        let options = parse_query_options(&params, set, Surface::Count)?;
        let count = count_rows(&db()?, set, options.filter.as_ref()).await?;
        return Ok(respond(StatusCode::OK, "text/plain", count.to_string()));
    }
    if segments.len() > 1 {
        return Err(ODataError::not_implemented(
            "Navigation properties and other resource paths are not supported",
        )
        .into());
    }

    if let Some(key) = key {
        let options = parse_query_options(&params, set, Surface::Entity)?;
        let select = options.select.as_deref();
        let Some(Js::Object(entity)) = fetch_entity(&db()?, set, &key, select).await? else {
            return Err(
                ODataError::not_found(format!("{} '{key}' not found", set.entity_type)).into(),
            );
        };
        let mut payload = vec![(
            "@odata.context".to_owned(),
            Js::String(context_url(&root, set, select, true)),
        )];
        payload.extend(entity);
        return Ok(json(StatusCode::OK, stringify(&Js::Object(payload))));
    }

    let options = parse_query_options(&params, set, Surface::Collection)?;
    let page = fetch_page(&db()?, set, &options).await?;
    let mut payload = vec![(
        "@odata.context".to_owned(),
        Js::String(context_url(&root, set, options.select.as_deref(), false)),
    )];
    if let Some(total) = page.total {
        // A count of rows: far below the 2^53 a JavaScript number holds.
        #[allow(clippy::cast_precision_loss)]
        payload.push(("@odata.count".to_owned(), Js::Number(total as f64)));
    }
    payload.push(("value".to_owned(), Js::Array(page.rows)));
    // `$top` that ends with this page is not linked on.
    if let Some(next) = &page.next
        && page.remaining_top != Some(0)
    {
        payload.push((
            "@odata.nextLink".to_owned(),
            Js::String(next_link(origin, path, &params, next, page.remaining_top)),
        ));
    }
    Ok(json(StatusCode::OK, stringify(&Js::Object(payload))))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use tower::ServiceExt;
    use weldsuite_db::WorkspaceRestrictions;

    use super::*;
    use crate::session::{ApiSession, KeyType};

    fn session(scopes: &[&str]) -> ApiSession {
        ApiSession {
            key_id: "key_test".to_owned(),
            key_type: KeyType::Workspace,
            workspace_id: "ws_test".to_owned(),
            user_id: None,
            scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
            tier: "enterprise".to_owned(),
            clerk_org_id: None,
            licensed_apps: None,
            read_only: false,
            read_only_reason: None,
            app_id: None,
            app_code: None,
            install_id: None,
            member: None,
        }
    }

    /// The feed under `/v1`, with the key layer's work done: a session with
    /// `scopes` (none for no session) and a database nothing here reaches.
    fn app(scopes: Option<&'static [&'static str]>) -> Router {
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://feed:unused@127.0.0.1:1/unused")
            .expect("a lazy pool");
        Router::new()
            .nest("/v1", mount(Router::new()))
            .layer(axum::middleware::from_fn(
                move |mut request: Request, next: Next| {
                    let db = db.clone();
                    async move {
                        if let Some(scopes) = scopes {
                            let session = session(scopes);
                            let tenant = Tenant {
                                workspace_id: session.workspace_id.clone(),
                                clerk_org_id: None,
                                db,
                                suspended: false,
                                restrictions: WorkspaceRestrictions::default(),
                            };
                            crate::insert_session(request.extensions_mut(), session, tenant);
                        }
                        next.run(request).await
                    }
                },
            ))
    }

    struct Answer {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    impl Answer {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).and_then(|value| value.to_str().ok())
        }
    }

    async fn send(app: Router, method: Method, uri: &str, headers: &[(&str, &str)]) -> Answer {
        let mut request = http::Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app
            .oneshot(request.body(Body::empty()).expect("a request"))
            .await
            .expect("an answer");
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX)
            .await
            .expect("a body");
        Answer {
            status: parts.status,
            headers: parts.headers,
            body: String::from_utf8(bytes.to_vec()).expect("text"),
        }
    }

    async fn get(uri: &str) -> Answer {
        send(app(Some(&["reports:read"])), Method::GET, uri, &[]).await
    }

    #[tokio::test]
    async fn the_service_document_uses_the_requests_origin() {
        let plain = get("/v1/odata").await;
        assert_eq!(plain.status, StatusCode::OK);
        assert_eq!(plain.header("content-type"), Some(JSON_TYPE));
        assert_eq!(plain.header("odata-version"), Some("4.0"));
        assert!(plain.body.starts_with(
            r#"{"@odata.context":"http://localhost/v1/odata/$metadata","value":[{"name":"Conversations","kind":"EntitySet","url":"Conversations"},"#
        ));
        assert_eq!(get("/v1/odata/").await.body, plain.body);

        let forwarded = send(
            app(Some(&["*"])),
            Method::GET,
            "/v1/odata",
            &[
                ("x-forwarded-host", "api.weldsuite.org"),
                ("x-forwarded-proto", "https"),
            ],
        )
        .await;
        assert!(
            forwarded.body.starts_with(
                r#"{"@odata.context":"https://api.weldsuite.org/v1/odata/$metadata","#
            )
        );
    }

    #[tokio::test]
    async fn metadata_is_the_csdl_as_xml() {
        let answer = get("/v1/odata/$metadata").await;
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.header("content-type"), Some("application/xml"));
        assert_eq!(answer.header("odata-version"), Some("4.0"));
        assert_eq!(answer.body, metadata_xml());
    }

    #[tokio::test]
    async fn a_write_is_a_405_before_the_scope_is_checked() {
        for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            for uri in [
                "/v1/odata",
                "/v1/odata/Conversations",
                "/v1/odata/Conversations('cnv_1')",
            ] {
                // Also for a key without the scope, and for no session at all.
                for scopes in [Some(&["*"][..]), Some(&["crm:*"][..]), None] {
                    let answer = send(app(scopes), method.clone(), uri, &[]).await;
                    assert_eq!(
                        answer.status,
                        StatusCode::METHOD_NOT_ALLOWED,
                        "{method} {uri}"
                    );
                    assert_eq!(answer.header("allow"), Some("GET, HEAD, OPTIONS"));
                    assert_eq!(answer.header("content-type"), Some(JSON_TYPE));
                    assert_eq!(answer.header("odata-version"), Some("4.0"));
                    assert_eq!(
                        answer.body,
                        r#"{"error":{"code":"MethodNotAllowed","message":"The OData feed is read-only."}}"#
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn the_feed_needs_the_reports_scope() {
        for uri in [
            "/v1/odata",
            "/v1/odata/$metadata",
            "/v1/odata/Conversations",
            "/v1/odata/Conversations/$count",
            "/v1/odata/Teams('team_1')",
        ] {
            let denied = send(
                app(Some(&["audit_logs:read", "crm:*"])),
                Method::GET,
                uri,
                &[],
            )
            .await;
            assert_eq!(denied.status, StatusCode::FORBIDDEN, "{uri}");
            assert_eq!(denied.header("odata-version"), Some("4.0"));
            assert_eq!(
                denied.body,
                r#"{"error":{"code":"FORBIDDEN","message":"Missing required scope: reports:read"}}"#
            );
            let anonymous = send(app(None), Method::GET, uri, &[]).await;
            assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{uri}");
            assert_eq!(anonymous.header("odata-version"), Some("4.0"));
        }
        for scopes in [&["reports:read"][..], &["reports:*"][..], &["*"][..]] {
            let allowed = send(app(Some(scopes)), Method::GET, "/v1/odata/$metadata", &[]).await;
            assert_eq!(allowed.status, StatusCode::OK, "{scopes:?}");
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)] // one table of requests and their refusals
    async fn what_is_not_served_is_refused_with_the_feeds_error_shape() {
        for (uri, status, code, message) in [
            (
                "/v1/odata/Nope",
                404,
                "NotFound",
                "The entity set 'Nope' does not exist",
            ),
            (
                "/v1/odata/Nope/$count",
                404,
                "NotFound",
                "The entity set 'Nope' does not exist",
            ),
            (
                "/v1/odata/Nope('x')",
                404,
                "NotFound",
                "The entity set 'Nope' does not exist",
            ),
            (
                "/v1/odata/conversations",
                404,
                "NotFound",
                "The entity set 'conversations' does not exist",
            ),
            (
                "/v1/odata/Conversations%2F",
                404,
                "NotFound",
                "Resource not found: Conversations/",
            ),
            (
                "/v1/odata/$batch",
                404,
                "NotFound",
                "Resource not found: $batch",
            ),
            (
                "/v1/odata/$metadata/x",
                404,
                "NotFound",
                "Resource not found: $metadata",
            ),
            (
                "/v1/odata/%E0%A4%A",
                400,
                "BadRequest",
                "The path is not valid percent-encoding",
            ),
            (
                "/v1/odata/Teams(team_1)",
                400,
                "BadRequest",
                "A key must be a string in single quotes, like Conversations('cnv_1')",
            ),
            (
                "/v1/odata/Teams(1)",
                400,
                "BadRequest",
                "A key must be a string in single quotes, like Conversations('cnv_1')",
            ),
            (
                "/v1/odata/Conversations('x';%20DROP%20TABLE%20desk_conversations)",
                400,
                "BadRequest",
                "A key must be a string in single quotes, like Conversations('cnv_1')",
            ),
            (
                "/v1/odata/Conversations/messages",
                501,
                "NotImplemented",
                "Navigation properties and other resource paths are not supported",
            ),
            (
                "/v1/odata/Conversations('cnv_1')/messages",
                501,
                "NotImplemented",
                "Navigation properties and other resource paths are not supported",
            ),
            (
                "/v1/odata/Conversations('cnv_1')/$count",
                501,
                "NotImplemented",
                "Navigation properties and other resource paths are not supported",
            ),
            (
                "/v1/odata/Conversations?$expand=x",
                501,
                "NotImplemented",
                "$expand is not supported",
            ),
            (
                "/v1/odata/Conversations?$inlinecount=allpages",
                400,
                "BadRequest",
                "Unknown query option '$inlinecount'",
            ),
            (
                "/v1/odata/Conversations?$top=1&$top=2",
                400,
                "BadRequest",
                "$top is given more than once",
            ),
            (
                "/v1/odata/Conversations?$top=abc",
                400,
                "BadRequest",
                "$top must be a non-negative integer",
            ),
            (
                "/v1/odata/Conversations?$select=id,(select%201)",
                400,
                "BadRequest",
                "Unknown property '(select 1)' in $select",
            ),
            (
                "/v1/odata/Conversations?$filter=title%20eq",
                400,
                "BadRequest",
                "Unexpected end of expression in $filter",
            ),
            (
                "/v1/odata/Conversations?$filter=",
                400,
                "BadRequest",
                "$filter is empty",
            ),
            (
                "/v1/odata/Conversations?$format=xml",
                415,
                "UnsupportedMediaType",
                "$format=xml is not supported, only json",
            ),
            (
                "/v1/odata/Conversations/$count?$top=1",
                400,
                "BadRequest",
                "$top is not allowed here",
            ),
            (
                "/v1/odata/Conversations/$count?$filter=nope%20eq%201",
                400,
                "BadRequest",
                "Unknown property 'nope' on Conversations",
            ),
            (
                "/v1/odata/Teams('team_1')?$filter=name%20eq%20'x'",
                400,
                "BadRequest",
                "$filter is not allowed here",
            ),
            (
                "/v1/odata/Teams('team_1')?$top=1",
                400,
                "BadRequest",
                "$top is not allowed here",
            ),
        ] {
            let answer = get(uri).await;
            assert_eq!(answer.status.as_u16(), status, "{uri}");
            assert_eq!(answer.header("content-type"), Some(JSON_TYPE), "{uri}");
            assert_eq!(answer.header("odata-version"), Some("4.0"), "{uri}");
            assert_eq!(
                answer.body,
                format!(
                    "{{\"error\":{{\"code\":\"{code}\",\"message\":{}}}}}",
                    serde_json::to_string(message).expect("a string")
                ),
                "{uri}"
            );
        }
    }

    #[test]
    fn segments_are_split_and_decoded() {
        let segments = |path: &str| path_segments(path).map_err(|error| error.message);
        assert_eq!(segments("/v1/odata"), Ok(vec![]));
        assert_eq!(segments("/v1/odata/"), Ok(vec![]));
        assert_eq!(
            segments("/v1/odata/$metadata"),
            Ok(vec!["$metadata".to_owned()])
        );
        assert_eq!(
            segments("/v1/odata//Conversations/$count/"),
            Ok(vec!["Conversations".to_owned(), "$count".to_owned()])
        );
        assert_eq!(
            segments("/v1/odata/Teams(%27team_1%27)"),
            Ok(vec!["Teams('team_1')".to_owned()])
        );
        assert_eq!(segments("/v1/odata/a%2Fb"), Ok(vec!["a/b".to_owned()]));
        assert_eq!(
            segments("/v1/odata/%C3%A9%F0%9F%98%80"),
            Ok(vec!["é😀".to_owned()])
        );
        for path in [
            "/v1/odata/%",
            "/v1/odata/%4",
            "/v1/odata/%zz",
            "/v1/odata/%E0%A4%A",
            "/v1/odata/%C3",
            "/v1/odata/%C3x%A9",
            "/v1/odata/%FF",
            "/v1/odata/%ED%A0%80",
            "/v1/odata/%+1",
        ] {
            assert_eq!(
                segments(path),
                Err("The path is not valid percent-encoding".to_owned()),
                "{path}"
            );
        }
        // Outside the feed's root there is nothing to split.
        assert_eq!(segments("/elsewhere/x"), Ok(vec![]));
    }

    #[test]
    fn a_segment_is_a_set_with_an_optional_quoted_key() {
        let parse = |segment: &str| {
            parse_segment(segment)
                .map(|(name, key)| (name.to_owned(), key))
                .map_err(|error| (error.status.as_u16(), error.message))
        };
        let key = |name: &str, key: &str| Ok((name.to_owned(), Some(key.to_owned())));
        assert_eq!(
            parse("Conversations"),
            Ok(("Conversations".to_owned(), None))
        );
        assert_eq!(
            parse("Conversations()"),
            Ok(("Conversations".to_owned(), None))
        );
        assert_eq!(
            parse("Conversations('cnv_1')"),
            key("Conversations", "cnv_1")
        );
        assert_eq!(parse("Teams('')"), key("Teams", ""));
        assert_eq!(parse("Teams('O''Brien')"), key("Teams", "O'Brien"));
        assert_eq!(parse("Teams('''')"), key("Teams", "'"));
        assert_eq!(parse("Teams('a)b')"), key("Teams", "a)b"));
        assert_eq!(parse("Teams('a\nb')"), key("Teams", "a\nb"));
        assert_eq!(
            parse("Conversations('cnv_1'' OR ''1''=''1')"),
            key("Conversations", "cnv_1' OR '1'='1")
        );
        let bad_key = Err((
            400,
            "A key must be a string in single quotes, like Conversations('cnv_1')".to_owned(),
        ));
        for segment in [
            "Teams(team_1)",
            "Teams(1)",
            "Teams(')",
            "Teams(''')",
            "Teams('a'b')",
            "Teams('a' or 'b')",
            "Teams('x'; DROP TABLE desk_conversations)",
            "Teams(\"x\")",
        ] {
            assert_eq!(parse(segment), bad_key, "{segment}");
        }
        for segment in [
            "$batch",
            "Conversations/",
            "Teams(",
            "Teams('x'",
            "Teams)",
            "Teams('x')y",
            "(x)",
            "Teams x",
            "é",
        ] {
            assert_eq!(
                parse(segment),
                Err((404, format!("Resource not found: {segment}"))),
                "{segment}"
            );
        }
    }

    #[test]
    fn the_origin_is_the_one_the_client_used() {
        let origin = |pairs: &[(&str, &str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes()).expect("a name"),
                    HeaderValue::from_str(value).expect("a value"),
                );
            }
            request_origin(&headers)
        };
        assert_eq!(origin(&[]), "http://localhost");
        assert_eq!(
            origin(&[("host", "localhost:8080")]),
            "http://localhost:8080"
        );
        assert_eq!(
            origin(&[("host", "example.test:80")]),
            "http://example.test"
        );
        assert_eq!(
            origin(&[
                ("host", "10.0.0.1:8080"),
                ("x-forwarded-host", "API.WeldSuite.org:443, proxy"),
                ("x-forwarded-proto", "https"),
            ]),
            "https://api.weldsuite.org"
        );
    }
}
