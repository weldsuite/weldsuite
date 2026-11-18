//! What the feed refuses with (`routes/v1/odata/errors.ts`):
//! `{ "error": { "code", "message" } }`.

use http::StatusCode;

/// `ODataError`: a status with its fixed code, and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ODataError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
    /// The message as a JSON string, when it holds half a surrogate pair
    /// (which a Rust string cannot): JavaScript reports the offending UTF-16
    /// unit and `JSON.stringify` escapes it.
    escaped: Option<String>,
}

impl ODataError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            escaped: None,
        }
    }

    /// `badRequest(message)`.
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    /// `notImplemented(message)`.
    pub(crate) fn not_implemented(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_IMPLEMENTED, message)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    /// A 400 whose message quotes `unit`, the first UTF-16 unit of a
    /// character outside the basic plane: `before`, the unit, `after`.
    pub(crate) fn bad_request_quoting_unit(before: &str, unit: u16, after: &str) -> Self {
        let quoted = |text: &str| {
            let json = serde_json::to_string(text).unwrap_or_default();
            json[1..json.len() - 1].to_owned()
        };
        Self {
            status: StatusCode::BAD_REQUEST,
            message: format!("{before}\u{fffd}{after}"),
            escaped: Some(format!(
                "\"{}\\u{unit:04x}{}\"",
                quoted(before),
                quoted(after)
            )),
        }
    }

    /// `CODES[status]`.
    pub(crate) fn code(&self) -> &'static str {
        code_of(self.status)
    }

    /// `JSON.stringify({ error: { code, message } })`.
    pub(crate) fn body(&self) -> String {
        let message = self
            .escaped
            .clone()
            .unwrap_or_else(|| serde_json::to_string(&self.message).unwrap_or_default());
        format!(
            "{{\"error\":{{\"code\":\"{}\",\"message\":{message}}}}}",
            self.code()
        )
    }
}

/// The code of each status the feed answers an error with.
pub(crate) fn code_of(status: StatusCode) -> &'static str {
    match status {
        StatusCode::NOT_FOUND => "NotFound",
        StatusCode::METHOD_NOT_ALLOWED => "MethodNotAllowed",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "UnsupportedMediaType",
        StatusCode::NOT_IMPLEMENTED => "NotImplemented",
        _ => "BadRequest",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_carry_the_code_of_their_status() {
        assert_eq!(ODataError::bad_request("x").code(), "BadRequest");
        assert_eq!(ODataError::not_found("x").code(), "NotFound");
        assert_eq!(ODataError::not_implemented("x").code(), "NotImplemented");
        assert_eq!(
            ODataError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "x").code(),
            "UnsupportedMediaType"
        );
        assert_eq!(code_of(StatusCode::METHOD_NOT_ALLOWED), "MethodNotAllowed");
    }

    #[test]
    fn the_body_is_the_error_object_with_code_first() {
        assert_eq!(
            ODataError::bad_request("Unknown property 'a\"b' on Teams").body(),
            r#"{"error":{"code":"BadRequest","message":"Unknown property 'a\"b' on Teams"}}"#
        );
    }

    #[test]
    fn half_a_surrogate_pair_is_escaped_as_javascript_does() {
        // '😀' is U+1F600: JavaScript's `text[i]` is its high surrogate.
        let error =
            ODataError::bad_request_quoting_unit("Unexpected character '", 0xd83d, "' in $filter");
        assert_eq!(
            error.body(),
            r#"{"error":{"code":"BadRequest","message":"Unexpected character '\ud83d' in $filter"}}"#
        );
    }
}
