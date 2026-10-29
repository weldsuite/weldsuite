//! What every WeldSuite API module is built on. The Rust counterpart of
//! `@weldsuite/worker-kit` (`packages/core/worker-kit/src`).
//!
//! Everything a client can observe must match the TypeScript workers: the
//! JSON envelope, error codes and messages, id formats, CORS headers and the
//! `X-Request-Id` header. The conformance suite (phase P2) holds the two
//! implementations to that; the unit tests here pin the shapes.
//!
//! "Match" means the same JSON after parsing, not the same bytes: JavaScript
//! prints the number `1.0` as `1`, `serde_json` as `1.0`. Use integer types
//! for values the TypeScript side emits as whole numbers.

pub mod cors;
pub mod cursor;
pub mod id;
pub mod log_safe;
pub mod pagination;
pub mod request_id;
pub mod response;

pub use cors::{
    api_cors, is_authorized_party, parse_extra_authorized_parties, resolve_cors_origin,
};
pub use id::{generate_id, random_string};
pub use log_safe::log_safe;
pub use pagination::{Page, parse_limit, parse_limit_or_fallback};
pub use request_id::{RequestId, request_id};
pub use response::{
    ApiError, ApiResult, Created, CreditShortfall, Data, List, NoContent, Pagination,
    WORKSPACE_MOVING_RETRY_AFTER_SECONDS,
};
