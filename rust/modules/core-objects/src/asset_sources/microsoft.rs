//! Microsoft's side of an asset source: the client-credentials token and the
//! pages of managed devices, and what a refusal means
//! (`@weldsuite/core-domain/asset-sources`: `intuneToken`, `fetchIntunePage`,
//! `testAssetSource`, the error codes).
//!
//! Only `login.microsoftonline.com` and `graph.microsoft.com` are ever
//! called: the tenant id is checked before it enters the token URL, and a
//! page link on another host is refused before it is followed. The client
//! secret never reaches an error or a log: every message here is fixed text.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::js_number_of;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::js::parse_int;

pub(crate) const TOKEN_HOST: &str = "login.microsoftonline.com";
pub(crate) const GRAPH_HOST: &str = "graph.microsoft.com";
/// The first page of managed devices (`INTUNE_DEVICES_URL`).
pub(crate) const DEVICES_URL: &str =
    "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices";
const GRAPH_SCOPE: &str = "https://graph.microsoft.com/.default";

/// How long to wait when Microsoft throttles without saying how long.
pub(crate) const DEFAULT_RETRY_AFTER_SECONDS: u32 = 60;
const MAX_RETRY_AFTER_SECONDS: u32 = 3600;

const OTHER_HOST: &str = "Microsoft sent a link to another host; the import was stopped.";

/// `ASSET_SOURCE_ERROR_CODES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ErrorCode {
    InvalidSecret,
    SecretExpired,
    TenantNotFound,
    AppNotFound,
    PermissionMissing,
    Throttled,
    Unreachable,
    SignInFailed,
    AssetRegisterMissing,
    /// The run was stopped after 24 hours. Unlike `Throttled`, it is over.
    RunTimeout,
}

impl ErrorCode {
    const ALL: [Self; 10] = [
        Self::InvalidSecret,
        Self::SecretExpired,
        Self::TenantNotFound,
        Self::AppNotFound,
        Self::PermissionMissing,
        Self::Throttled,
        Self::Unreachable,
        Self::SignInFailed,
        Self::AssetRegisterMissing,
        Self::RunTimeout,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSecret => "invalid_secret",
            Self::SecretExpired => "secret_expired",
            Self::TenantNotFound => "tenant_not_found",
            Self::AppNotFound => "app_not_found",
            Self::PermissionMissing => "permission_missing",
            Self::Throttled => "throttled",
            Self::Unreachable => "unreachable",
            Self::SignInFailed => "sign_in_failed",
            Self::AssetRegisterMissing => "asset_register_missing",
            Self::RunTimeout => "run_timeout",
        }
    }

    /// `ASSET_SOURCE_ERROR_MESSAGES[code]`.
    fn message(self) -> &'static str {
        match self {
            Self::InvalidSecret => {
                "Microsoft rejected the client secret. Check that you copied the secret Value, not the Secret ID."
            }
            Self::SecretExpired => {
                "The client secret has expired. Create a new one in the Entra admin center and replace it here."
            }
            Self::TenantNotFound => {
                "Microsoft could not find this tenant. Check the Directory (tenant) ID."
            }
            Self::AppNotFound => {
                "The application was not found in this tenant. Check the Application (client) ID and that the app registration is in this directory."
            }
            Self::PermissionMissing => {
                "Microsoft refused access to the devices. Add the DeviceManagementManagedDevices.Read.All application permission, grant admin consent, and make sure the tenant has an Intune licence."
            }
            Self::Throttled => "Microsoft asked us to slow down. The import continues shortly.",
            Self::Unreachable => {
                "Microsoft could not be reached. The import tries again on its next run."
            }
            Self::SignInFailed => {
                "Microsoft did not accept the sign-in. Check the tenant id, the client id and the client secret."
            }
            Self::AssetRegisterMissing => {
                "The asset register is not set up. Set it up before importing devices."
            }
            Self::RunTimeout => {
                "The import did not finish within 24 hours and was stopped. It starts again on schedule."
            }
        }
    }

    fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == code)
    }
}

/// `AssetSourceError`: why Microsoft (or the asset register) refused, in
/// words fit for the settings page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceError {
    pub(crate) code: ErrorCode,
    pub(crate) message: String,
    /// With `throttled`: how long Microsoft asked to wait.
    pub(crate) retry_after_seconds: Option<u32>,
}

impl SourceError {
    /// The code with its own message.
    pub(crate) fn new(code: ErrorCode) -> Self {
        Self::with_message(code, code.message())
    }

    pub(crate) fn with_message(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
            retry_after_seconds: None,
        }
    }

    fn throttled(retry_after_seconds: u32) -> Self {
        Self {
            retry_after_seconds: Some(retry_after_seconds),
            ..Self::new(ErrorCode::Throttled)
        }
    }

    /// `formatAssetSourceError`: `lastError` is stored as `<code>: <message>`.
    pub(crate) fn stored(&self) -> String {
        format!("{}: {}", self.code.as_str(), self.message)
    }
}

/// `parseAssetSourceError`: a stored `lastError` as its code and message. A
/// text that does not start with a known code is all message.
pub(crate) fn parse_stored_error(stored: Option<&str>) -> (Option<&'static str>, Option<String>) {
    let Some(stored) = stored.filter(|stored| !stored.is_empty()) else {
        return (None, None);
    };
    let code = stored
        .split_once(": ")
        .and_then(|(code, message)| ErrorCode::parse(code).map(|code| (code, message)));
    match code {
        Some((code, message)) => (Some(code.as_str()), Some(message.to_owned())),
        None => (None, Some(stored.to_owned())),
    }
}

// ── what may go into a URL ──────────────────────────────────────────────────

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
fn is_guid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// `/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i`:
/// labels of letters, digits and inner hyphens, and a top-level domain of
/// letters.
fn is_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    let mut labels: Vec<&str> = value.split('.').collect();
    let Some(top) = labels.pop() else {
        return false;
    };
    if labels.is_empty()
        || !(2..=63).contains(&top.len())
        || !top.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    labels.iter().all(|label| {
        let bytes = label.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
    })
}

/// `isValidEntraTenantId`: an Entra tenant is a GUID or a verified domain
/// name; nothing else may reach the token URL.
pub(crate) fn is_valid_entra_tenant_id(value: &str) -> bool {
    is_guid(value) || is_hostname(value)
}

/// `isGraphUrl`: only Graph itself, over https, without credentials or a
/// port: the `@odata.nextLink` of a page.
pub(crate) fn is_graph_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some(GRAPH_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
}

// ── the calls ───────────────────────────────────────────────────────────────

/// `retryAfterOf`: the `Retry-After` seconds, a minute when there is none,
/// an hour at most.
fn retry_after_of(response: &HttpResponse) -> u32 {
    let asked = parse_int(response.header("retry-after").unwrap_or_default());
    match asked {
        Some(seconds) if seconds >= 1 => u32::try_from(seconds)
            .map_or(MAX_RETRY_AFTER_SECONDS, |seconds| {
                seconds.min(MAX_RETRY_AFTER_SECONDS)
            }),
        _ => DEFAULT_RETRY_AFTER_SECONDS,
    }
}

/// `jsonOf`: the body when it is a JSON object.
fn json_of(response: &HttpResponse) -> Option<Map<String, Value>> {
    // `Response.json()` reads past a byte order mark.
    let body = response
        .body
        .strip_prefix(b"\xEF\xBB\xBF")
        .unwrap_or(&response.body);
    match serde_json::from_slice(body) {
        Ok(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

/// `tokenErrorCode`: Microsoft's `error_codes` decide, never the free text.
fn token_error_code(body: Option<&Map<String, Value>>) -> ErrorCode {
    let codes: Vec<f64> = match body.and_then(|body| body.get("error_codes")) {
        Some(Value::Array(codes)) => codes.iter().map(|code| js_number_of(Some(code))).collect(),
        _ => Vec::new(),
    };
    #[allow(clippy::float_cmp)] // whole numbers, as `includes` compares them
    let has = |code: f64| codes.contains(&code);
    if has(7_000_222.0) {
        ErrorCode::SecretExpired
    } else if has(7_000_215.0) || has(7_000_218.0) {
        ErrorCode::InvalidSecret
    } else if has(90_002.0) {
        ErrorCode::TenantNotFound
    } else if has(700_016.0) {
        ErrorCode::AppNotFound
    } else {
        ErrorCode::SignInFailed
    }
}

/// One call; a failure to connect (or no client at all) is `unreachable`.
async fn send(
    http: Option<&OutboundHttp>,
    request: HttpRequest,
) -> Result<HttpResponse, SourceError> {
    let Some(http) = http else {
        return Err(SourceError::new(ErrorCode::Unreachable));
    };
    http.send(request)
        .await
        .map_err(|_| SourceError::new(ErrorCode::Unreachable))
}

/// The token request's form body, as `new URLSearchParams({...}).toString()`
/// writes it.
fn token_form(client_id: &str, secret: &str) -> String {
    form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("client_secret", secret)
        .append_pair("scope", GRAPH_SCOPE)
        .append_pair("grant_type", "client_credentials")
        .finish()
}

/// `intuneToken`: a client-credentials token for Microsoft Graph.
pub(crate) async fn intune_token(
    http: Option<&OutboundHttp>,
    tenant_id: &str,
    client_id: &str,
    secret: &str,
) -> Result<String, SourceError> {
    if !is_valid_entra_tenant_id(tenant_id) {
        return Err(SourceError::new(ErrorCode::TenantNotFound));
    }
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: format!("https://{TOKEN_HOST}/{tenant_id}/oauth2/v2.0/token"),
        headers: vec![
            (
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
            ("Accept".to_owned(), "application/json".to_owned()),
        ],
        body: Some(token_form(client_id, secret).into_bytes()),
    };
    let response = send(http, request).await?;

    if matches!(response.status, 429 | 503) {
        return Err(SourceError::throttled(retry_after_of(&response)));
    }
    if !response.ok() {
        if response.status >= 500 {
            return Err(SourceError::new(ErrorCode::Unreachable));
        }
        return Err(SourceError::new(token_error_code(
            json_of(&response).as_ref(),
        )));
    }
    match json_of(&response).and_then(|mut body| body.remove("access_token")) {
        Some(Value::String(token)) if !token.is_empty() => Ok(token),
        _ => Err(SourceError::new(ErrorCode::SignInFailed)),
    }
}

/// `IntunePage`.
#[derive(Debug, PartialEq)]
pub(crate) struct Page {
    pub(crate) devices: Vec<Value>,
    /// The `@odata.nextLink`, verbatim; `None` on the last page.
    pub(crate) next_link: Option<String>,
}

/// `fetchIntunePage`: one page of managed devices, the first when `link` is
/// `None`, otherwise the link a page gave.
pub(crate) async fn fetch_intune_page(
    http: Option<&OutboundHttp>,
    token: &str,
    link: Option<&str>,
) -> Result<Page, SourceError> {
    let other_host = || SourceError::with_message(ErrorCode::Unreachable, OTHER_HOST);
    let url = link.unwrap_or(DEVICES_URL);
    if !is_graph_url(url) {
        return Err(other_host());
    }
    let request = HttpRequest::empty("GET", url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json");
    let response = send(http, request).await?;

    if matches!(response.status, 429 | 503) {
        return Err(SourceError::throttled(retry_after_of(&response)));
    }
    if matches!(response.status, 401 | 403) {
        return Err(SourceError::new(ErrorCode::PermissionMissing));
    }
    if !response.ok() {
        return Err(SourceError::new(ErrorCode::Unreachable));
    }

    let mut body = json_of(&response).unwrap_or_default();
    let Some(Value::Array(entries)) = body.remove("value") else {
        return Err(SourceError::new(ErrorCode::Unreachable));
    };
    // An entry that is not an object becomes a device without an id: it
    // counts as failed, in its place on the page, instead of stopping the
    // whole import.
    let devices = entries
        .into_iter()
        .map(|entry| {
            if entry.is_object() {
                entry
            } else {
                Value::Object(serde_json::Map::new())
            }
        })
        .collect();
    let next_link = match body.remove("@odata.nextLink") {
        Some(Value::String(next)) if !next.is_empty() => {
            if !is_graph_url(&next) {
                return Err(other_host());
            }
            Some(next)
        }
        _ => None,
    };
    Ok(Page { devices, next_link })
}

/// `testAssetSource`: the token plus the first page; saves nothing and
/// never fails. `deviceCount` is that page's, not the total.
pub(crate) async fn test_source(
    http: Option<&OutboundHttp>,
    tenant_id: &str,
    client_id: &str,
    secret: &str,
) -> Value {
    let tried = async {
        let token = intune_token(http, tenant_id, client_id, secret).await?;
        fetch_intune_page(http, &token, None).await
    }
    .await;
    match tried {
        Ok(page) => json!({ "ok": true, "deviceCount": page.devices.len() }),
        Err(failure) => refusal(&failure),
    }
}

/// A refused test: `{ ok: false, code, message }`.
pub(crate) fn refusal(failure: &SourceError) -> Value {
    json!({ "ok": false, "code": failure.code.as_str(), "message": failure.message })
}

#[cfg(test)]
pub(crate) mod tests {
    //! The cases of `asset-sources.test.ts` that are Microsoft's: the tenant
    //! id and `@odata.nextLink` checks, the error mapping, `Retry-After`.

    use std::sync::{Arc, Mutex};

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, PortError};

    use super::*;

    const TENANT: &str = "11111111-2222-3333-4444-555555555555";
    const CLIENT: &str = "cccccccc-2222-3333-4444-555555555555";

    type Answer = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, PortError> + Send + Sync>;

    /// A Microsoft that answers by URL and method, and keeps what it was asked.
    pub(crate) struct Stub {
        answer: Answer,
        pub(crate) calls: Mutex<Vec<HttpRequest>>,
    }

    impl DynOutboundHttp for Stub {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            let answer = (self.answer)(&request);
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(request);
            Box::pin(std::future::ready(answer))
        }
    }

    pub(crate) fn stub(
        answer: impl Fn(&HttpRequest) -> Result<HttpResponse, PortError> + Send + Sync + 'static,
    ) -> (OutboundHttp, Arc<Stub>) {
        let stub = Arc::new(Stub {
            answer: Box::new(answer),
            calls: Mutex::default(),
        });
        (OutboundHttp(stub.clone()), stub)
    }

    #[allow(clippy::unnecessary_wraps)] // a stub's answer is a result
    pub(crate) fn answer(status: u16, body: &Value) -> Result<HttpResponse, PortError> {
        Ok(HttpResponse::new(status, body.to_string().into_bytes()))
    }

    #[allow(clippy::unnecessary_wraps)] // a stub's answer is a result
    fn with_retry_after(status: u16, seconds: &str) -> Result<HttpResponse, PortError> {
        Ok(HttpResponse {
            status,
            body: b"{}".to_vec(),
            headers: vec![("retry-after".to_owned(), seconds.to_owned())],
        })
    }

    fn calls(stub: &Stub) -> Vec<String> {
        stub.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|call| format!("{} {}", call.method, call.url))
            .collect()
    }

    #[test]
    fn a_tenant_is_a_guid_or_a_domain_name() {
        for valid in [TENANT, "contoso.onmicrosoft.com", "Example.COM"] {
            assert!(is_valid_entra_tenant_id(valid), "{valid}");
        }
        // Anything that could change the URL is refused.
        let with_path = format!("{TENANT}/x");
        for invalid in [
            "",
            "contoso",
            "a/b.com",
            "evil.com/../x",
            "a.com?x=1",
            "a.com#x",
            "a b.com",
            "..",
            "a..com",
            "-a.com",
            "a.com\n",
            "user@example.com",
            "a/../b",
            with_path.as_str(),
        ] {
            assert!(!is_valid_entra_tenant_id(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn a_page_link_is_https_on_graph_only() {
        assert!(is_graph_url(DEVICES_URL));
        assert!(is_graph_url(
            "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=abc"
        ));
        for refused in [
            "http://graph.microsoft.com/v1.0/x",
            "https://evil.example.com/v1.0/x",
            "https://graph.microsoft.com.evil.example/v1.0/x",
            "https://graph.microsoft.com:8443/v1.0/x",
            "https://user:pw@graph.microsoft.com/v1.0/x",
            "https://login.microsoftonline.com/x",
            "not a url",
            "",
        ] {
            assert!(!is_graph_url(refused), "{refused}");
        }
    }

    #[tokio::test]
    async fn the_token_request_is_the_form_post_typescript_sends() {
        let (http, microsoft) = stub(|request| {
            if request.method == "POST"
                && request.url
                    == format!("https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token")
            {
                answer(
                    200,
                    &json!({ "token_type": "Bearer", "expires_in": 3599, "access_token": "tok" }),
                )
            } else {
                answer(404, &json!({}))
            }
        });
        let token = intune_token(Some(&http), TENANT, CLIENT, "s3cret & more/+=").await;
        assert_eq!(token.as_deref(), Ok("tok"));
        let sent = microsoft
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 1);
        // `new URLSearchParams({ client_id, client_secret, scope, grant_type }).toString()`.
        assert_eq!(
            sent[0]
                .body
                .as_deref()
                .map(String::from_utf8_lossy)
                .as_deref(),
            Some(
                "client_id=cccccccc-2222-3333-4444-555555555555\
                 &client_secret=s3cret+%26+more%2F%2B%3D\
                 &scope=https%3A%2F%2Fgraph.microsoft.com%2F.default\
                 &grant_type=client_credentials"
            )
        );
        assert_eq!(
            sent[0].headers,
            [
                (
                    "Content-Type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned()
                ),
                ("Accept".to_owned(), "application/json".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn token_refusals_map_by_error_code() {
        for (code, expected) in [
            (7_000_215, ErrorCode::InvalidSecret),
            (7_000_218, ErrorCode::InvalidSecret),
            (7_000_222, ErrorCode::SecretExpired),
            (90_002, ErrorCode::TenantNotFound),
            (700_016, ErrorCode::AppNotFound),
            (50_034, ErrorCode::SignInFailed),
        ] {
            let (http, _) = stub(move |_| {
                answer(
                    401,
                    &json!({ "error": "invalid_client", "error_description": "AADSTS…", "error_codes": [code] }),
                )
            });
            let refused = intune_token(Some(&http), TENANT, CLIENT, "s").await;
            assert_eq!(refused.map_err(|error| error.code), Err(expected), "{code}");
        }
        // A token answer without a token is a failed sign-in.
        let (http, _) = stub(|_| answer(200, &json!({ "token_type": "Bearer" })));
        let refused = intune_token(Some(&http), TENANT, CLIENT, "s").await;
        assert_eq!(
            refused.map_err(|error| error.code),
            Err(ErrorCode::SignInFailed)
        );
    }

    #[tokio::test]
    async fn a_bad_tenant_id_never_reaches_the_network() {
        let (http, microsoft) = stub(|_| answer(200, &json!({})));
        let refused = intune_token(Some(&http), "a/../b", CLIENT, "s").await;
        assert_eq!(
            refused.map_err(|error| error.code),
            Err(ErrorCode::TenantNotFound)
        );
        assert_eq!(calls(&microsoft), Vec::<String>::new());
    }

    #[tokio::test]
    async fn throttling_server_errors_and_network_failures_map_without_the_secret() {
        let (http, _) = stub(|_| with_retry_after(429, "45"));
        let throttled = intune_token(Some(&http), TENANT, CLIENT, "s").await;
        assert_eq!(
            throttled.map_err(|error| (error.code, error.retry_after_seconds)),
            Err((ErrorCode::Throttled, Some(45)))
        );
        let (http, _) = stub(|_| answer(500, &json!({})));
        let down = intune_token(Some(&http), TENANT, CLIENT, "s").await;
        assert_eq!(
            down.map_err(|error| error.code),
            Err(ErrorCode::Unreachable)
        );
        let (http, _) = stub(|_| Err(PortError::backend("fetch failed s3cret")));
        let offline = intune_token(Some(&http), TENANT, CLIENT, "s3cret").await;
        let Err(failure) = offline else {
            panic!("a failure");
        };
        assert_eq!(failure.code, ErrorCode::Unreachable);
        assert!(!failure.message.contains("s3cret"));
        // Without a client at all the answer is the same.
        let none = intune_token(None, TENANT, CLIENT, "s").await;
        assert_eq!(
            none.map_err(|error| error.code),
            Err(ErrorCode::Unreachable)
        );
    }

    #[tokio::test]
    async fn a_page_hands_back_its_devices_and_the_next_link_verbatim() {
        let next = format!("{DEVICES_URL}?$skiptoken=abc");
        let link = next.clone();
        let (http, microsoft) = stub(move |request| {
            if request.url == DEVICES_URL {
                answer(
                    200,
                    &json!({ "value": [{ "id": "a" }], "@odata.nextLink": link }),
                )
            } else {
                answer(404, &json!({}))
            }
        });
        let page = fetch_intune_page(Some(&http), "tok", None).await;
        assert_eq!(
            page,
            Ok(Page {
                devices: vec![json!({ "id": "a" })],
                next_link: Some(next)
            })
        );
        assert_eq!(calls(&microsoft), [format!("GET {DEVICES_URL}")]);
        let headers = microsoft
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)[0]
            .headers
            .clone();
        assert_eq!(
            headers,
            [
                ("Authorization".to_owned(), "Bearer tok".to_owned()),
                ("Accept".to_owned(), "application/json".to_owned()),
            ]
        );

        // An empty page, which is also the last.
        let (http, _) = stub(|_| answer(200, &json!({ "value": [] })));
        assert_eq!(
            fetch_intune_page(Some(&http), "tok", None).await,
            Ok(Page {
                devices: Vec::new(),
                next_link: None
            })
        );
    }

    #[tokio::test]
    async fn an_entry_that_is_not_an_object_stays_in_its_place_without_an_id() {
        let (http, _) =
            stub(|_| answer(200, &json!({ "value": [null, { "id": "a" }, "x", [1], 7] })));
        assert_eq!(
            fetch_intune_page(Some(&http), "tok", None).await,
            Ok(Page {
                devices: vec![
                    json!({}),
                    json!({ "id": "a" }),
                    json!({}),
                    json!({}),
                    json!({})
                ],
                next_link: None
            })
        );
    }

    #[tokio::test]
    async fn a_link_to_another_host_is_refused_before_it_is_called() {
        let (http, microsoft) = stub(|_| answer(200, &json!({ "value": [] })));
        let refused =
            fetch_intune_page(Some(&http), "tok", Some("https://evil.example.com/x")).await;
        assert_eq!(
            refused,
            Err(SourceError::with_message(
                ErrorCode::Unreachable,
                OTHER_HOST
            ))
        );
        assert_eq!(calls(&microsoft), Vec::<String>::new());

        let (http, _) = stub(|_| {
            answer(
                200,
                &json!({ "value": [], "@odata.nextLink": "https://evil.example.com/next" }),
            )
        });
        let refused = fetch_intune_page(Some(&http), "tok", None).await;
        assert_eq!(
            refused.map_err(|error| error.code),
            Err(ErrorCode::Unreachable)
        );
    }

    #[tokio::test]
    async fn page_refusals_map_by_status() {
        for status in [401, 403] {
            let (http, _) = stub(move |_| answer(status, &json!({})));
            let refused = fetch_intune_page(Some(&http), "t", None).await;
            assert_eq!(
                refused.map_err(|error| error.code),
                Err(ErrorCode::PermissionMissing)
            );
        }
        for (status, header, seconds) in [
            (429, Some("120"), 120),
            // No `Retry-After`: a minute.
            (503, None, 60),
            // An absurd one is capped at an hour.
            (429, Some("999999"), 3600),
            (429, Some("soon"), 60),
            (429, Some("0"), 60),
        ] {
            let (http, _) = stub(move |_| match header {
                Some(header) => with_retry_after(status, header),
                None => answer(status, &json!({})),
            });
            let refused = fetch_intune_page(Some(&http), "t", None).await;
            assert_eq!(
                refused.map_err(|error| (error.code, error.retry_after_seconds)),
                Err((ErrorCode::Throttled, Some(seconds)))
            );
        }
        for body in [json!({}), json!({ "nope": true })] {
            let status = if body == json!({}) { 500 } else { 200 };
            let (http, _) = stub(move |_| answer(status, &body));
            let refused = fetch_intune_page(Some(&http), "t", None).await;
            assert_eq!(
                refused.map_err(|error| error.code),
                Err(ErrorCode::Unreachable)
            );
        }
    }

    #[tokio::test]
    async fn a_test_answers_with_the_count_or_the_code_and_message() {
        let (http, _) = stub(|request| {
            if request.method == "POST" {
                answer(200, &json!({ "access_token": "tok" }))
            } else if request.url == DEVICES_URL {
                answer(200, &json!({ "value": [{ "id": "a" }, { "id": "b" }] }))
            } else {
                answer(404, &json!({}))
            }
        });
        assert_eq!(
            test_source(Some(&http), TENANT, CLIENT, "s").await,
            json!({ "ok": true, "deviceCount": 2 })
        );

        let (http, _) = stub(|request| {
            if request.method == "POST" {
                answer(401, &json!({ "error_codes": [7_000_215] }))
            } else {
                answer(200, &json!({}))
            }
        });
        assert_eq!(
            test_source(Some(&http), TENANT, CLIENT, "s").await,
            json!({
                "ok": false,
                "code": "invalid_secret",
                "message": "Microsoft rejected the client secret. Check that you copied the secret Value, not the Secret ID.",
            })
        );

        let (http, _) = stub(|request| {
            if request.method == "POST" {
                answer(200, &json!({ "access_token": "tok" }))
            } else {
                answer(403, &json!({ "error": { "code": "Forbidden" } }))
            }
        });
        let denied = test_source(Some(&http), TENANT, CLIENT, "s").await;
        assert_eq!(denied["code"], "permission_missing");
    }

    #[test]
    fn a_stored_error_round_trips_its_code_and_message() {
        let stored = SourceError::new(ErrorCode::PermissionMissing).stored();
        assert!(stored.starts_with("permission_missing: Microsoft refused access"));
        let (code, message) = parse_stored_error(Some(&stored));
        assert_eq!(code, Some("permission_missing"));
        assert_eq!(
            message.as_deref(),
            Some(ErrorCode::PermissionMissing.message())
        );
        assert_eq!(
            parse_stored_error(Some("something else: broke")),
            (None, Some("something else: broke".to_owned()))
        );
        assert_eq!(
            parse_stored_error(Some("permission_missing: Microsoft refused access.")),
            (
                Some("permission_missing"),
                Some("Microsoft refused access.".to_owned())
            )
        );
        assert_eq!(parse_stored_error(None), (None, None));
        assert_eq!(parse_stored_error(Some("")), (None, None));
    }
}
