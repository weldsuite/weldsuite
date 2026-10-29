//! Clerk token rules against fixed tokens (`fixtures/clerk-tokens.json`,
//! written by `fixtures/generate-clerk-tokens.mjs`).

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Body;
use axum::routing::get;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;
use weldsuite_auth::{
    AuthContext, ClerkVerifier, SessionVerifier, TokenError, clerk_auth, require_second_factor,
};

const EXTENSION: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("fixtures/clerk-tokens.json")).expect("fixture parses")
});

fn now() -> u64 {
    FIXTURE["now"].as_u64().expect("now")
}

fn token(name: &str) -> &'static str {
    FIXTURE["tokens"][name]
        .as_str()
        .unwrap_or_else(|| panic!("no token {name}"))
}

fn pem_verifier() -> ClerkVerifier {
    ClerkVerifier::from_pem(
        FIXTURE["publicKeyPem"].as_str().expect("pem"),
        Some(EXTENSION),
    )
    .expect("pem loads")
}

fn jwks_verifier() -> ClerkVerifier {
    ClerkVerifier::from_jwks(&FIXTURE["jwks"].to_string(), None).expect("jwks loads")
}

fn verify(name: &str) -> Result<AuthContext, TokenError> {
    pem_verifier().verify(token(name), now())
}

#[test]
fn a_valid_token_yields_the_session() {
    let context = verify("valid").expect("valid");
    assert_eq!(context.user_id, "user_2abc");
    assert_eq!(context.org_id.as_deref(), Some("org_2abc"));
    assert_eq!(context.session_id, "sess_2abc");
    assert_eq!(context.factor_verification_age, Some([3.0, 7.0]));
}

#[test]
fn the_organization_comes_from_o_id_then_org_id() {
    assert_eq!(
        verify("orgIdClaim").expect("ok").org_id.as_deref(),
        Some("org_legacy")
    );
    assert_eq!(verify("noOrg").expect("ok").org_id, None);
}

#[test]
fn missing_sid_and_fva_are_tolerated() {
    assert_eq!(verify("noSid").expect("ok").session_id, "");
    assert_eq!(verify("noFva").expect("ok").factor_verification_age, None);
    assert_eq!(
        verify("malformedFva").expect("ok").factor_verification_age,
        None
    );
}

#[test]
fn azp_rules() {
    assert!(verify("noAzp").is_ok(), "native apps send no azp");
    assert!(verify("extensionAzp").is_ok(), "configured extra origin");
    for name in ["foreignAzp", "emptyAzp", "numericAzp"] {
        assert_eq!(verify(name), Err(TokenError::UnauthorizedParty), "{name}");
    }
    // Without the extra origin configured, the extension is refused.
    assert_eq!(
        jwks_verifier().verify(token("extensionAzp"), now()),
        Err(TokenError::UnauthorizedParty)
    );
}

#[test]
fn time_claims_allow_five_seconds_of_skew() {
    assert_eq!(verify("expired"), Err(TokenError::Expired));
    assert!(verify("expiredWithinSkew").is_ok());
    assert_eq!(verify("noExp"), Err(TokenError::MissingExpiry));
    assert_eq!(verify("notYetValid"), Err(TokenError::NotYetValid));
    assert_eq!(verify("issuedInFuture"), Err(TokenError::IssuedInFuture));
}

#[test]
fn subject_rules() {
    assert_eq!(verify("noSub"), Err(TokenError::MissingSubject));
    assert_eq!(verify("emptySub"), Err(TokenError::EmptySubject));
}

#[test]
fn signatures_algorithms_and_shapes_are_checked() {
    assert_eq!(verify("otherKey"), Err(TokenError::BadSignature));
    assert_eq!(
        verify("hs256WithPublicKey"),
        Err(TokenError::UnsupportedAlgorithm)
    );
    assert!(verify("algNone").is_err());
    assert_eq!(verify("wrongTyp"), Err(TokenError::UnsupportedType));
    assert_eq!(verify("malformed"), Err(TokenError::Malformed));
}

#[test]
fn a_jwks_picks_the_key_by_kid() {
    let verifier = jwks_verifier();
    assert!(verifier.verify(token("valid"), now()).is_ok());
    assert_eq!(
        verifier.verify(token("unknownKid"), now()),
        Err(TokenError::UnknownKey)
    );
    // A single PEM key ignores the kid, as Clerk's `jwtKey` does.
    assert!(pem_verifier().verify(token("unknownKid"), now()).is_ok());
}

#[test]
fn authenticate_answers_like_clerk_middleware() {
    let verifier = pem_verifier();
    let message = |header: Option<&str>| {
        verifier
            .authenticate(header, now())
            .expect_err("refused")
            .message()
            .to_owned()
    };
    assert_eq!(message(None), "Missing or invalid Authorization header");
    assert_eq!(
        message(Some(&format!("bearer {}", token("valid")))),
        "Missing or invalid Authorization header"
    );
    assert_eq!(
        message(Some(&format!("Bearer {}", token("emptySub")))),
        "Invalid token payload"
    );
    assert_eq!(
        message(Some(&format!("Bearer {}", token("expired")))),
        "Token verification failed"
    );
    let error = verifier
        .authenticate(Some(&format!("Bearer {}", token("foreignAzp"))), now())
        .expect_err("refused");
    assert_eq!(error.status().as_u16(), 401);
    assert_eq!(error.code(), "UNAUTHORIZED");
}

#[test]
fn second_factor_errors_match_require_second_factor() {
    let context = |name| verify(name).expect("valid token");
    assert!(require_second_factor(&context("valid"), 10).is_ok());

    let error = require_second_factor(&context("noSecondFactor"), 10).expect_err("refused");
    assert_eq!(
        (error.status().as_u16(), error.code()),
        (403, "MFA_REQUIRED")
    );

    let error = require_second_factor(&context("staleSecondFactor"), 10).expect_err("refused");
    assert_eq!(
        (error.status().as_u16(), error.code()),
        (403, "REVERIFICATION_REQUIRED")
    );
    assert_eq!(
        error.details(),
        Some(&serde_json::json!({ "level": "second_factor", "afterMinutes": 10 }))
    );
}

#[tokio::test]
async fn middleware_rejects_without_a_token_and_handlers_get_the_context() {
    let verifier = Arc::new(SessionVerifier::from(pem_verifier()));
    let app = Router::new()
        .route(
            "/me",
            get(|context: AuthContext| async move { context.user_id }),
        )
        .layer(axum::middleware::from_fn_with_state(verifier, clerk_auth));

    let response = app
        .clone()
        .oneshot(
            http::Request::builder()
                .uri("/me")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), 401);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(
        body.as_ref(),
        br#"{"error":{"code":"UNAUTHORIZED","message":"Missing or invalid Authorization header"}}"#
    );

    // The middleware reads the real clock and the fixture tokens are only
    // valid around their fixed `now` (January 2027), so a signed-in request
    // is covered by the verifier tests above. Here: an AuthContext in the
    // extensions reaches the handler.
    let context = verify("valid").expect("valid");
    let app = Router::new()
        .route(
            "/me",
            get(|context: AuthContext| async move { context.user_id }),
        )
        .layer(axum::Extension(context));
    let response = app
        .oneshot(
            http::Request::builder()
                .uri("/me")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), 200);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(body.as_ref(), b"user_2abc");
}
