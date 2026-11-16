//! The Zitadel sign-in adapter against a mock of Zitadel's API that validates
//! requests the way Zitadel v4.19 does where it has bitten us.

use axum::Router;
use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use serde_json::json;
use weldsuite_adapters_oss::{ZitadelSignIn, ZitadelSignInOptions};
use weldsuite_ports::SignInProvider;

/// `GET /v2/users/{id}/authentication_methods`: a `domainQuery` without
/// `domain` fails validation (`DomainQuery.Domain: value length must be
/// between 1 and 200 runes`), as Zitadel answers it.
async fn handle(uri: Uri) -> impl IntoResponse {
    if uri.path() != "/v2/users/u1/authentication_methods" {
        return (StatusCode::NOT_FOUND, json!({ "code": 5 }).to_string());
    }
    let query = uri.query().unwrap_or_default();
    if query.contains("domainQuery.") && !query.contains("domainQuery.domain=") {
        return (
            StatusCode::BAD_REQUEST,
            json!({
                "code": 3,
                "message": "invalid ListAuthenticationMethodTypesRequest.DomainQuery: embedded message failed validation",
            })
            .to_string(),
        );
    }
    let answer = json!({
        "details": { "totalResult": "3" },
        "authMethodTypes": [
            "AUTHENTICATION_METHOD_TYPE_PASSWORD",
            "AUTHENTICATION_METHOD_TYPE_TOTP",
            "AUTHENTICATION_METHOD_TYPE_U2F",
        ],
    });
    (StatusCode::OK, answer.to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_methods_are_read_without_a_domain_query_zitadel_refuses() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let app = Router::new().fallback(handle);
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    let provider = ZitadelSignIn::new(ZitadelSignInOptions {
        api_url: format!("http://{address}/"),
        token: "pat-test".to_owned(),
        host: None,
        public_url: None,
    })
    .expect("client");

    let methods = provider.auth_methods("u1").await.expect("methods");
    assert!(methods.password);
    assert!(methods.totp);
    assert!(methods.security_key);
    assert!(!methods.passkey);
    assert!(methods.any_second_factor());
}
