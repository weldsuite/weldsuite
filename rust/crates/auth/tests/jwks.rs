//! Keys fetched from a JWKS URL: fetched once, reused, sent the bearer token,
//! and fetched again (throttled) for an unknown key id.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::http::HeaderMap;
use axum::routing::get;
use serde_json::Value;
use weldsuite_auth::{SessionVerifier, TokenError};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/clerk-tokens.json")).expect("fixture parses")
}

/// Serve the fixture's JWKS; count the requests that carried the right bearer.
async fn jwks_server(jwks: String) -> (String, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    let app = Router::new().route(
        "/v1/jwks",
        get(move |headers: HeaderMap| {
            let counter = Arc::clone(&counter);
            let jwks = jwks.clone();
            async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok())
                    == Some("Bearer sk_test_secret")
                {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                jwks
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    (format!("http://{address}/v1/jwks"), hits)
}

#[tokio::test(flavor = "multi_thread")]
async fn fetches_once_and_reuses_the_keys() {
    let fixture = fixture();
    let now = fixture["now"].as_u64().expect("now");
    let token = |name: &str| fixture["tokens"][name].as_str().expect("token").to_owned();
    let (url, hits) = jwks_server(fixture["jwks"].to_string()).await;

    let verifier =
        SessionVerifier::remote(url, Some("sk_test_secret".to_owned()), None).expect("client");
    let context = verifier.verify(&token("valid"), now).await.expect("valid");
    assert_eq!(context.user_id, "user_2abc");
    verifier.verify(&token("valid"), now).await.expect("valid");
    assert_eq!(hits.load(Ordering::SeqCst), 1, "the key set is reused");

    // An unknown key id asks for a fresh set, but not more than every 30 s.
    assert_eq!(
        verifier.verify(&token("unknownKid"), now).await,
        Err(TokenError::UnknownKey)
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    let refused = verifier
        .authenticate(Some(&format!("Bearer {}", token("expired"))), now)
        .await
        .expect_err("expired");
    assert_eq!(refused.message(), "Token verification failed");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_jwks_refuses_tokens() {
    let fixture = fixture();
    let now = fixture["now"].as_u64().expect("now");
    let verifier =
        SessionVerifier::remote("http://127.0.0.1:1/v1/jwks", None, None).expect("client");
    let token = fixture["tokens"]["valid"].as_str().expect("token");
    assert_eq!(
        verifier.verify(token, now).await,
        Err(TokenError::UnknownKey)
    );
}
