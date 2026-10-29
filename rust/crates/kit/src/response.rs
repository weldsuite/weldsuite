//! The response envelope shared by every API worker
//! (`packages/core/worker-kit/src/response.ts`), so `@weldsuite/api-client` and
//! the shared Zod schemas work against Rust and TypeScript alike:
//!
//! ```text
//! { "data": T }                                                   200 / 201
//! { "data": [T], "pagination": { totalCount, hasMore, cursor } }  200
//! { "error": { code, message, details? } }                        4xx / 5xx
//! (empty body)                                                    204
//! ```

use std::borrow::Cow;
use std::fmt;

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::{HeaderValue, StatusCode};
use serde::Serialize;
use serde_json::Value;

/// `{ "data": T }` with status 200.
#[derive(Debug, Clone, Serialize)]
pub struct Data<T>(pub T);

/// `{ "data": T }` with status 201.
#[derive(Debug, Clone, Serialize)]
pub struct Created<T>(pub T);

/// A page of results: `{ "data": [T], "pagination": … }` with status 200.
#[derive(Debug, Clone, Serialize)]
pub struct List<T> {
    pub data: Vec<T>,
    pub pagination: Pagination,
}

impl<T> List<T> {
    /// `list(c, data, pagination)`.
    pub fn new(data: Vec<T>, pagination: Pagination) -> Self {
        Self { data, pagination }
    }
}

/// `cursorPagination()` in TypeScript. `cursor` is serialised as `null`, never
/// left out, when there is no next page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagination {
    pub total_count: u64,
    pub has_more: bool,
    pub cursor: Option<String>,
}

impl Pagination {
    /// `cursorPagination(totalCount, hasMore, cursor)`.
    pub fn new(total_count: u64, has_more: bool, cursor: Option<String>) -> Self {
        Self {
            total_count,
            has_more,
            cursor,
        }
    }
}

/// 204 with an empty body.
#[derive(Debug, Clone, Copy)]
pub struct NoContent;

#[derive(Serialize)]
struct DataBody<'a, T> {
    data: &'a T,
}

impl<T: Serialize> IntoResponse for Data<T> {
    fn into_response(self) -> Response {
        Json(DataBody { data: &self.0 }).into_response()
    }
}

impl<T: Serialize> IntoResponse for Created<T> {
    fn into_response(self) -> Response {
        (StatusCode::CREATED, Json(DataBody { data: &self.0 })).into_response()
    }
}

impl<T: Serialize> IntoResponse for List<T> {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}

impl IntoResponse for NoContent {
    fn into_response(self) -> Response {
        StatusCode::NO_CONTENT.into_response()
    }
}

/// What a handler returns: a response, or an [`ApiError`] that renders as the
/// error envelope.
pub type ApiResult<T> = Result<T, ApiError>;

/// How long clients are told to wait during a workspace database move
/// (`WORKSPACE_MOVING_RETRY_AFTER_SECONDS`): a move drains in 60 to 90 seconds
/// at the soonest.
pub const WORKSPACE_MOVING_RETRY_AFTER_SECONDS: u32 = 30;

/// An error response: `{ "error": { code, message, details? } }`.
///
/// The constructors mirror `error.*` in `response.ts`, with the same codes,
/// statuses and default messages. `details` is left out of the JSON when it is
/// `None`, as `JSON.stringify` drops `undefined`; `Some(Value::Null)` prints
/// `null`. A `Retry-After` header goes with it when one is set.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    status: StatusCode,
    code: Cow<'static, str>,
    message: String,
    details: Option<Value>,
    retry_after: Option<u32>,
}

/// Body of `error.insufficientCredits`. Missing fields are left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditShortfall {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortfall: Option<f64>,
}

impl ApiError {
    /// Any status and code. Prefer the named constructors.
    pub fn new(
        status: StatusCode,
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
            retry_after: None,
        }
    }

    /// Attach `details` to the error body.
    #[must_use]
    pub fn with_details(mut self, details: impl Serialize) -> Self {
        // Serialising a value we were handed only fails for maps with
        // non-string keys; dropping the details then beats failing the request.
        self.details = serde_json::to_value(details).ok();
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn details(&self) -> Option<&Value> {
        self.details.as_ref()
    }

    /// The `Retry-After` header, in seconds, when the response carries one.
    pub fn retry_after(&self) -> Option<u32> {
        self.retry_after
    }

    /// Send `Retry-After: <seconds>` with the error.
    #[must_use]
    pub fn with_retry_after(mut self, seconds: u32) -> Self {
        self.retry_after = Some(seconds);
        self
    }

    /// 400 `BAD_REQUEST`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
    }

    /// 401 `UNAUTHORIZED`, "Unauthorized".
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized")
    }

    /// 403 `FORBIDDEN`, "Forbidden".
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", "Forbidden")
    }

    /// 404 `NOT_FOUND`: "`<resource>` with ID '`<id>`' not found", or
    /// "`<resource>` not found" without an id.
    pub fn not_found(resource: &str, id: Option<&str>) -> Self {
        let message = match id {
            Some(id) if !id.is_empty() => format!("{resource} with ID '{id}' not found"),
            _ => format!("{resource} not found"),
        };
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
    }

    /// 409 `CONFLICT`.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "CONFLICT", message)
    }

    /// 402 `INSUFFICIENT_CREDITS`: the prepaid wallet is empty; the client
    /// offers a top-up.
    pub fn insufficient_credits(details: Option<CreditShortfall>) -> Self {
        let error = Self::new(
            StatusCode::PAYMENT_REQUIRED,
            "INSUFFICIENT_CREDITS",
            "Insufficient credits. Top up your workspace balance to continue.",
        );
        match details {
            Some(details) => error.with_details(details),
            None => error,
        }
    }

    /// 402 with a caller-chosen code (`USAGE_LIMIT_REACHED`, …): a plan or
    /// wallet limit refused the request.
    pub fn payment_required(
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(StatusCode::PAYMENT_REQUIRED, code, message)
    }

    /// 500 `INTERNAL_ERROR`, "Internal server error".
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Internal server error",
        )
    }

    /// 503 `SERVICE_UNAVAILABLE`.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            message,
        )
    }

    /// 502 `UPSTREAM_ERROR`, "Upstream service error": a provider we depend on
    /// failed and the request can be retried.
    pub fn bad_gateway() -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_ERROR",
            "Upstream service error",
        )
    }

    /// 503 `WORKSPACE_MOVING` with `Retry-After: 30`
    /// (`workspaceMovingResponse` in `workspace-moving.ts`): the workspace's
    /// tenant database is being moved, so the client retries instead of
    /// failing. The licence gate answers it during a move, and so does a
    /// request the tenant database refused because it moved
    /// (`weldsuite_db::classify_moved_database_error`).
    pub fn workspace_moving() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "WORKSPACE_MOVING",
            "This workspace is being moved to a new database. Try again in a minute.",
        )
        .with_retry_after(WORKSPACE_MOVING_RETRY_AFTER_SECONDS)
    }

    /// 400 `ORG_REQUIRED`: the route needs a workspace context.
    pub fn org_required() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "ORG_REQUIRED",
            "Organization context required",
        )
    }

    /// Replace the default message (`unauthorized`, `forbidden`, `internal`,
    /// `bad_gateway` take one in TypeScript).
    #[must_use]
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.code,
            self.message
        )
    }
}

impl std::error::Error for ApiError {}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorFields<'a>,
}

#[derive(Serialize)]
struct ErrorFields<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<&'a Value>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorFields {
                code: &self.code,
                message: &self.message,
                details: self.details.as_ref(),
            },
        };
        let mut response = (self.status, Json(body)).into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(http::header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use serde_json::json;

    async fn render(response: impl IntoResponse) -> (StatusCode, Option<String>, String) {
        let response = response.into_response();
        let status = response.status();
        let content_type = response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap_or_default().to_owned());
        let bytes = response
            .into_body()
            .collect()
            .await
            .map(http_body_util::Collected::to_bytes)
            .unwrap_or_default();
        (
            status,
            content_type,
            String::from_utf8(bytes.to_vec()).unwrap_or_default(),
        )
    }

    #[tokio::test]
    async fn data_is_wrapped_with_status_200_and_json_content_type() {
        let (status, content_type, body) = render(Data(json!({"id": "cus_1"}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(body, r#"{"data":{"id":"cus_1"}}"#);
    }

    #[tokio::test]
    async fn created_uses_status_201() {
        let (status, _, body) = render(Created(json!({"id": "cus_1"}))).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body, r#"{"data":{"id":"cus_1"}}"#);
    }

    #[tokio::test]
    async fn list_keeps_a_null_cursor() {
        let page = List {
            data: vec![json!({"id": "a"})],
            pagination: Pagination {
                total_count: 1,
                has_more: false,
                cursor: None,
            },
        };
        let (status, _, body) = render(page).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            r#"{"data":[{"id":"a"}],"pagination":{"totalCount":1,"hasMore":false,"cursor":null}}"#
        );
    }

    #[tokio::test]
    async fn no_content_is_an_empty_204() {
        let (status, content_type, body) = render(NoContent).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(content_type, None);
        assert_eq!(body, "");
    }

    #[tokio::test]
    async fn errors_leave_out_missing_details() {
        let (status, _, body) = render(ApiError::forbidden()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body,
            r#"{"error":{"code":"FORBIDDEN","message":"Forbidden"}}"#
        );
    }

    #[tokio::test]
    async fn errors_carry_details_when_given() {
        let error = ApiError::bad_request("Invalid body").with_details(json!({"field": "name"}));
        let (status, _, body) = render(error).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            r#"{"error":{"code":"BAD_REQUEST","message":"Invalid body","details":{"field":"name"}}}"#
        );
    }

    #[test]
    fn named_errors_match_the_typescript_codes_statuses_and_messages() {
        let cases = [
            (
                ApiError::unauthorized(),
                401,
                "UNAUTHORIZED",
                "Unauthorized",
            ),
            (ApiError::forbidden(), 403, "FORBIDDEN", "Forbidden"),
            (
                ApiError::not_found("Customer", Some("cus_1")),
                404,
                "NOT_FOUND",
                "Customer with ID 'cus_1' not found",
            ),
            (
                ApiError::not_found("Customer", None),
                404,
                "NOT_FOUND",
                "Customer not found",
            ),
            (ApiError::conflict("Taken"), 409, "CONFLICT", "Taken"),
            (
                ApiError::insufficient_credits(None),
                402,
                "INSUFFICIENT_CREDITS",
                "Insufficient credits. Top up your workspace balance to continue.",
            ),
            (
                ApiError::payment_required("USAGE_LIMIT_REACHED", "Limit"),
                402,
                "USAGE_LIMIT_REACHED",
                "Limit",
            ),
            (
                ApiError::internal(),
                500,
                "INTERNAL_ERROR",
                "Internal server error",
            ),
            (
                ApiError::unavailable("Down"),
                503,
                "SERVICE_UNAVAILABLE",
                "Down",
            ),
            (
                ApiError::bad_gateway(),
                502,
                "UPSTREAM_ERROR",
                "Upstream service error",
            ),
            (
                ApiError::org_required(),
                400,
                "ORG_REQUIRED",
                "Organization context required",
            ),
        ];
        for (error, status, code, message) in cases {
            assert_eq!(error.status().as_u16(), status, "{code}");
            assert_eq!(error.code(), code);
            assert_eq!(error.message(), message);
        }
    }

    // workspace-moving.test.ts: workspaceMovingBody / workspaceMovingResponse.
    #[tokio::test]
    async fn workspace_moving_is_a_503_with_the_body_and_retry_after_30() {
        assert_eq!(WORKSPACE_MOVING_RETRY_AFTER_SECONDS, 30);
        let response = ApiError::workspace_moving().into_response();
        assert_eq!(
            response
                .headers()
                .get(http::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("30")
        );
        let (status, content_type, body) = render(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        let body: Value = serde_json::from_str(&body).unwrap_or_default();
        assert_eq!(
            body,
            json!({"error": {
                "code": "WORKSPACE_MOVING",
                "message": "This workspace is being moved to a new database. Try again in a minute.",
            }})
        );
    }

    #[tokio::test]
    async fn other_errors_send_no_retry_after() {
        let response = ApiError::unavailable("Down").into_response();
        assert!(response.headers().get(http::header::RETRY_AFTER).is_none());
    }

    #[test]
    fn cursor_pagination_builds_the_meta() {
        let page = List::new(
            vec![1_u8],
            Pagination::new(3, true, Some("cus_1".to_owned())),
        );
        assert_eq!(
            serde_json::to_value(&page).unwrap_or_default(),
            json!({"data": [1], "pagination": {"totalCount": 3, "hasMore": true, "cursor": "cus_1"}})
        );
    }

    #[test]
    fn not_found_treats_an_empty_id_as_missing_like_javascript() {
        assert_eq!(
            ApiError::not_found("Customer", Some("")).message(),
            "Customer not found"
        );
    }

    #[test]
    fn insufficient_credits_details_leave_out_missing_fields() {
        let error = ApiError::insufficient_credits(Some(CreditShortfall {
            current_balance: Some(2.5),
            required: None,
            shortfall: Some(7.5),
        }));
        assert_eq!(
            error.details(),
            Some(&json!({"currentBalance": 2.5, "shortfall": 7.5}))
        );
    }
}
