//! OIDC token rules against fixed tokens (`fixtures/oidc-tokens.json`,
//! written by `fixtures/generate-oidc-tokens.mjs`), discovery and key
//! rotation against a mock provider, and the middleware with an OIDC
//! verifier.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use axum::Router;
use axum::body::Body;
use axum::routing::get;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::{
    AuthContext, OidcSettings, SessionVerifier, TokenError, require_second_factor, session_auth,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("fixtures/oidc-tokens.json")).expect("fixture parses")
});

fn now() -> u64 {
    FIXTURE["now"].as_u64().expect("now")
}

fn text(name: &str) -> String {
    FIXTURE[name].as_str().expect(name).to_owned()
}

fn token(name: &str) -> &'static str {
    FIXTURE["tokens"][name]
        .as_str()
        .unwrap_or_else(|| panic!("no token {name}"))
}

fn settings() -> OidcSettings {
    OidcSettings::new(text("issuer"), vec![text("project")])
}

fn verifier_with(settings: OidcSettings, jwks: &str) -> SessionVerifier {
    SessionVerifier::oidc_with_jwks(settings, &FIXTURE[jwks].to_string()).expect("jwks loads")
}

async fn verify(name: &str) -> Result<AuthContext, TokenError> {
    verifier_with(settings(), "jwksMixed")
        .verify(token(name), now())
        .await
}

#[tokio::test]
async fn a_valid_token_maps_its_claims() {
    let context = verify("valid").await.expect("valid");
    assert_eq!(context.user_id, text("user"));
    assert_eq!(context.org_id, Some(text("org")));
    assert_eq!(context.session_id, "V1_300000000000000777");
    // Signed in ten minutes ago with two factors.
    assert_eq!(context.factor_verification_age, Some([10.0, 10.0]));
    assert!(require_second_factor(&context, 11).is_ok());
}

#[tokio::test]
async fn accepted_shapes() {
    for name in ["ec", "atJwt", "audString", "expiredWithinSkew", "noSid"] {
        assert!(verify(name).await.is_ok(), "{name}");
    }
    assert_eq!(verify("noSid").await.expect("ok").session_id, "");
    // A one-key set serves a token without a kid; a larger set does not.
    let single = verifier_with(settings(), "jwks");
    assert!(single.verify(token("noKid"), now()).await.is_ok());
    assert_eq!(verify("noKid").await, Err(TokenError::UnknownKey));
}

#[tokio::test]
async fn issuer_and_audience_are_checked() {
    assert_eq!(verify("wrongIssuer").await, Err(TokenError::WrongIssuer));
    assert_eq!(
        verify("issuerWithSlash").await,
        Err(TokenError::WrongIssuer)
    );
    assert_eq!(
        verify("wrongAudience").await,
        Err(TokenError::WrongAudience)
    );
    assert_eq!(verify("noAudience").await, Err(TokenError::WrongAudience));
    // Any configured audience will do: here the client id.
    let by_client = OidcSettings::new(text("issuer"), vec!["x".to_owned(), text("client")]);
    assert!(
        verifier_with(by_client, "jwks")
            .verify(token("valid"), now())
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn times_subjects_signatures_and_algorithms() {
    assert_eq!(verify("expired").await, Err(TokenError::Expired));
    assert_eq!(verify("noExp").await, Err(TokenError::MissingExpiry));
    assert_eq!(verify("notYetValid").await, Err(TokenError::NotYetValid));
    assert_eq!(verify("noSub").await, Err(TokenError::MissingSubject));
    assert_eq!(verify("emptySub").await, Err(TokenError::EmptySubject));
    assert_eq!(verify("otherKey").await, Err(TokenError::BadSignature));
    assert_eq!(verify("unknownKid").await, Err(TokenError::UnknownKey));
    assert_eq!(verify("wrongTyp").await, Err(TokenError::UnsupportedType));
    assert_eq!(verify("hs256").await, Err(TokenError::UnsupportedAlgorithm));
    assert_eq!(
        verify("algMismatch").await,
        Err(TokenError::UnsupportedAlgorithm)
    );
    assert!(verify("algNone").await.is_err());
    assert_eq!(verify("malformed").await, Err(TokenError::Malformed));
}

#[tokio::test]
async fn the_organization_claim_is_configurable() {
    assert_eq!(verify("noOrg").await.expect("ok").org_id, None);
    assert_eq!(verify("rolesClaim").await.expect("ok").org_id, None);
    let roles = OidcSettings {
        org_claim: "urn:zitadel:iam:org:project:roles".to_owned(),
        ..settings()
    };
    let context = verifier_with(roles, "jwks")
        .verify(token("rolesClaim"), now())
        .await
        .expect("ok");
    assert_eq!(context.org_id, Some(text("org")));
}

#[tokio::test]
async fn second_factor_from_amr_and_auth_time() {
    let context = verify("passwordOnly").await.expect("ok");
    assert_eq!(context.factor_verification_age, Some([10.0, -1.0]));
    let error = require_second_factor(&context, 10).expect_err("refused");
    assert_eq!(error.code(), "MFA_REQUIRED");

    let context = verify("noAuthTime").await.expect("ok");
    assert_eq!(context.factor_verification_age, None);
    let error = require_second_factor(&context, 10).expect_err("refused");
    assert_eq!(error.code(), "REVERIFICATION_REQUIRED");

    // Two factors, but longer ago than the window.
    let error = require_second_factor(&verify("valid").await.expect("ok"), 10).expect_err("stale");
    assert_eq!(error.code(), "REVERIFICATION_REQUIRED");
}

#[test]
fn settings_must_name_an_issuer_audience_and_claim() {
    let jwks = FIXTURE["jwks"].to_string();
    let empty_audience = OidcSettings::new(text("issuer"), vec![]);
    assert!(SessionVerifier::oidc_with_jwks(empty_audience, &jwks).is_err());
    let empty_issuer = OidcSettings::new("", vec![text("project")]);
    assert!(SessionVerifier::oidc(empty_issuer).is_err());
    let empty_claim = OidcSettings {
        org_claim: String::new(),
        ..settings()
    };
    assert!(SessionVerifier::oidc(empty_claim).is_err());
    // A JWKS with only keys that can't verify signatures is refused.
    let unusable = json!({ "keys": [{ "kty": "oct", "k": "c2VjcmV0" }] }).to_string();
    assert!(SessionVerifier::oidc_with_jwks(settings(), &unusable).is_err());
}

// ── discovery and rotation against a mock provider ───────────────────────────

struct Provider {
    base: String,
    discovery_hits: Arc<AtomicUsize>,
    jwks_hits: Arc<AtomicUsize>,
    jwks: Arc<Mutex<Value>>,
}

/// A provider serving a discovery document that names `issuer` (the
/// provider's own address when `None`) and the JWKS in `jwks`.
async fn provider(issuer: Option<&str>, jwks: Value) -> Provider {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let issuer = issuer.map_or_else(|| base.clone(), str::to_owned);
    let discovery_hits = Arc::new(AtomicUsize::new(0));
    let jwks_hits = Arc::new(AtomicUsize::new(0));
    let jwks = Arc::new(Mutex::new(jwks));
    let document = json!({
        "issuer": issuer,
        "jwks_uri": format!("{base}/oauth/v2/keys"),
        "id_token_signing_alg_values_supported": ["RS256"],
    })
    .to_string();
    let app = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get({
                let hits = Arc::clone(&discovery_hits);
                move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let document = document.clone();
                    async move { document }
                }
            }),
        )
        .route(
            "/oauth/v2/keys",
            get({
                let hits = Arc::clone(&jwks_hits);
                let jwks = Arc::clone(&jwks);
                move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let body = jwks.lock().expect("lock").to_string();
                    async move { body }
                }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    Provider {
        base,
        discovery_hits,
        jwks_hits,
        jwks,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_configured_jwks_url_skips_discovery_and_is_fetched_once() {
    let provider = provider(Some(&text("issuer")), FIXTURE["jwks"].clone()).await;
    let verifier = SessionVerifier::oidc(OidcSettings {
        jwks_url: Some(format!("{}/oauth/v2/keys", provider.base)),
        ..settings()
    })
    .expect("verifier");
    verifier.verify(token("valid"), now()).await.expect("valid");
    verifier.verify(token("valid"), now()).await.expect("valid");
    assert_eq!(provider.jwks_hits.load(Ordering::SeqCst), 1);
    assert_eq!(provider.discovery_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_reads_the_document_once_then_the_jwks() {
    // The verifier's issuer is the mock's address, so discovery reaches it;
    // the fixture tokens name the fixture issuer, so a token whose signature
    // checks out then fails on the issuer: proof the keys were fetched.
    let provider = provider(None, FIXTURE["jwks"].clone()).await;
    let verifier = SessionVerifier::oidc(OidcSettings::new(
        provider.base.clone(),
        vec![text("project")],
    ))
    .expect("verifier");
    for _ in 0..2 {
        assert_eq!(
            verifier.verify(token("valid"), now()).await,
            Err(TokenError::WrongIssuer)
        );
    }
    assert_eq!(provider.discovery_hits.load(Ordering::SeqCst), 1);
    assert_eq!(provider.jwks_hits.load(Ordering::SeqCst), 1);
    // An unreachable issuer: no keys, every token refused.
    let unreachable = SessionVerifier::oidc(OidcSettings::new(
        "http://127.0.0.1:1",
        vec![text("project")],
    ))
    .expect("verifier");
    assert_eq!(
        unreachable.verify(token("valid"), now()).await,
        Err(TokenError::UnknownKey)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rotated_key_is_fetched_but_not_more_often_than_the_interval() {
    let provider = provider(Some(&text("issuer")), FIXTURE["jwks"].clone()).await;
    let verifier = |interval| {
        SessionVerifier::oidc(OidcSettings {
            jwks_url: Some(format!("{}/oauth/v2/keys", provider.base)),
            ..settings()
        })
        .expect("verifier")
        .with_refetch_interval(interval)
    };

    // The default 30 seconds: a key published since the last fetch waits.
    let throttled = verifier(std::time::Duration::from_secs(30));
    throttled
        .verify(token("valid"), now())
        .await
        .expect("valid");
    *provider.jwks.lock().expect("lock") = FIXTURE["jwksRotated"].clone();
    assert_eq!(
        throttled.verify(token("rotated"), now()).await,
        Err(TokenError::UnknownKey)
    );
    assert_eq!(provider.jwks_hits.load(Ordering::SeqCst), 1);

    // Past the interval, the unknown kid fetches the new set and passes.
    *provider.jwks.lock().expect("lock") = FIXTURE["jwks"].clone();
    let eager = verifier(std::time::Duration::ZERO);
    eager.verify(token("valid"), now()).await.expect("valid");
    *provider.jwks.lock().expect("lock") = FIXTURE["jwksRotated"].clone();
    let context = eager
        .verify(token("rotated"), now())
        .await
        .expect("rotated key");
    assert_eq!(context.user_id, text("user"));
    assert_eq!(provider.jwks_hits.load(Ordering::SeqCst), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_discovery_document_for_another_issuer_is_refused() {
    let provider = provider(Some("https://somebody.else.test"), FIXTURE["jwks"].clone()).await;
    let verifier = SessionVerifier::oidc(OidcSettings::new(
        provider.base.clone(),
        vec![text("project")],
    ))
    .expect("verifier");
    assert_eq!(
        verifier.verify(token("valid"), now()).await,
        Err(TokenError::UnknownKey)
    );
    assert_eq!(provider.discovery_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        provider.jwks_hits.load(Ordering::SeqCst),
        0,
        "keys never fetched"
    );
}

// ── the middleware ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_middleware_puts_the_oidc_context_on_the_request() {
    let verifier = Arc::new(verifier_with(settings(), "jwks"));
    assert_eq!(verifier.provider(), "OIDC");
    let app = Router::new()
        .route(
            "/me",
            get(|context: AuthContext| async move {
                format!(
                    "{}|{}|{}",
                    context.user_id,
                    context.org_id.unwrap_or_default(),
                    context.session_id
                )
            }),
        )
        .layer(axum::middleware::from_fn_with_state(verifier, session_auth));

    let call = |authorization: Option<String>| {
        let app = app.clone();
        async move {
            let mut request = http::Request::builder().uri("/me");
            if let Some(value) = authorization {
                request = request.header("authorization", value);
            }
            let response = app
                .oneshot(request.body(Body::empty()).expect("request"))
                .await
                .expect("response");
            let status = response.status().as_u16();
            let body = response
                .into_body()
                .collect()
                .await
                .expect("body")
                .to_bytes();
            (status, String::from_utf8(body.to_vec()).expect("utf-8"))
        }
    };

    // `longLived` is valid on the real clock until 2096.
    let (status, body) = call(Some(format!("Bearer {}", token("longLived")))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        format!("{}|{}|V1_300000000000000777", text("user"), text("org"))
    );

    let (status, body) = call(None).await;
    assert_eq!(status, 401);
    assert!(body.contains("Missing or invalid Authorization header"));

    let (status, body) = call(Some(format!("Bearer {}", token("expired")))).await;
    assert_eq!(status, 401);
    assert!(body.contains("Token verification failed"));
}

// ── against a real provider ──────────────────────────────────────────────────

/// A token from a real provider, verified through its discovery document on
/// the real clock. Runs when `WELDSUITE_TEST_OIDC_ISSUER`,
/// `WELDSUITE_TEST_OIDC_AUDIENCE` and `WELDSUITE_TEST_OIDC_TOKEN` are set
/// (e.g. a Zitadel machine user's JWT access token from `client_credentials`
/// with the `urn:zitadel:iam:org:project:id:{id}:aud` and
/// `urn:zitadel:iam:org:id:{org}` scopes); `WELDSUITE_TEST_OIDC_ORG` is the
/// organization it should map to.
#[tokio::test(flavor = "multi_thread")]
async fn a_live_provider_token_verifies_through_discovery() {
    let (Ok(issuer), Ok(audience), Ok(token)) = (
        std::env::var("WELDSUITE_TEST_OIDC_ISSUER"),
        std::env::var("WELDSUITE_TEST_OIDC_AUDIENCE"),
        std::env::var("WELDSUITE_TEST_OIDC_TOKEN"),
    ) else {
        eprintln!("WELDSUITE_TEST_OIDC_* not set; skipping");
        return;
    };
    let verifier =
        SessionVerifier::oidc(OidcSettings::new(issuer, vec![audience])).expect("verifier");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let context = verifier.verify(&token, now).await.expect("verified");
    assert_ne!(context.user_id, "");
    if let Ok(org) = std::env::var("WELDSUITE_TEST_OIDC_ORG") {
        assert_eq!(context.org_id, Some(org));
    }
}
