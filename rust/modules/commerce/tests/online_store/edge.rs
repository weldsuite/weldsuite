//! The storefront edge's gates: unknown hosts, the primary host, coming
//! soon, the password and the renderer being away.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode, header};
use serde_json::json;
use weldsuite_commerce::online_store::edge::{EdgeState, edge_router};

use crate::harness::{ALL, Env, env, send};

fn edge(env: &Env) -> axum::Router {
    edge_router(EdgeState::new(
        env.master.clone(),
        Arc::clone(&env.workspaces),
        env.config(),
        None,
        None,
        vec!["https://app.example.test".to_owned()],
        1,
    ))
}

fn get(host: &str, path: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header(header::HOST, host)
        .header("x-forwarded-proto", "https")
        .header(header::ACCEPT_LANGUAGE, "nl-NL,nl;q=0.9")
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn the_edge_gates_a_shop_by_host_visibility_and_password() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let edge = edge(&env);
    let (site_id, _) = staff.site().await;
    let host = staff.free_address(&site_id).await;

    let missing = send(&edge, get("nobody.example.com", "/")).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert!(
        missing
            .body
            .as_str()
            .unwrap()
            .contains("Hier is geen winkel")
    );

    // Not published yet: coming soon.
    let soon = send(&edge, get(&host, "/")).await;
    assert_eq!(soon.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(soon.body.as_str().unwrap().contains("binnenkort"));

    // Plain HTTP goes to HTTPS.
    let plain = Request::builder()
        .uri("/products?x=1")
        .header(header::HOST, &host)
        .header("x-forwarded-proto", "http")
        .body(Body::empty())
        .unwrap();
    let plain = send(&edge, plain).await;
    assert_eq!(plain.status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        plain.headers[header::LOCATION],
        format!("https://{host}/products?x=1").as_str()
    );

    let (status, _) = staff
        .post(
            &format!("/online-store/sites/{site_id}/publish"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = staff
        .patch(
            &format!("/online-store/sites/{site_id}"),
            &json!({ "visibility": "password", "password": "open sesame" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let locked = send(&edge, get(&host, "/products")).await;
    assert_eq!(locked.status, StatusCode::UNAUTHORIZED);
    assert!(
        locked
            .body
            .as_str()
            .unwrap()
            .contains("action=\"/__password\"")
    );
    assert_eq!(locked.headers[header::CACHE_CONTROL], "no-store");

    let post = |password: &str| {
        Request::builder()
            .method("POST")
            .uri("/__password")
            .header(header::HOST, &host)
            .header("x-forwarded-proto", "https")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(format!("password={password}")))
            .unwrap()
    };
    let wrong = send(&edge, post("nope")).await;
    assert_eq!(wrong.status, StatusCode::FORBIDDEN);
    let right = send(&edge, post("open+sesame")).await;
    assert_eq!(right.status, StatusCode::SEE_OTHER);
    let cookie = right.headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        cookie.starts_with("wsf_pass=") && cookie.contains("HttpOnly") && cookie.contains("Secure"),
        "{cookie}"
    );

    // With the pass, the request goes on to the renderer, which isn't
    // configured here: the edge's own "can't be reached" page.
    let pass = cookie.split(';').next().unwrap().to_owned();
    let mut through = get(&host, "/products");
    through
        .headers_mut()
        .insert(header::COOKIE, pass.parse().unwrap());
    let through = send(&edge, through).await;
    assert_eq!(through.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(through.body.as_str().unwrap().contains("niet bereikbaar"));
}
