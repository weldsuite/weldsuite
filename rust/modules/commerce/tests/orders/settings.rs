//! `/api/commerce-settings`: created on first read, the sequence only goes up.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, tenant};

#[tokio::test]
async fn read_creates_the_defaults_and_update_keeps_the_sequence_up() {
    let Some(db) = tenant() else { return };
    let app = app(db, ALL);

    let (status, body) = app.get("/commerce-settings").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["orderNumberPrefix"].is_string());
    assert!(body["data"]["defaultCurrency"].is_string());
    let current = body["data"]["nextOrderNumber"].as_i64().expect("number");

    // Going up works; other tests take numbers meanwhile, so leave room.
    let target = current + 1_000_000;
    let (status, body) = app
        .patch("/commerce-settings", &json!({ "nextOrderNumber": target }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["nextOrderNumber"], target);

    // Backwards is refused and says where the sequence is.
    let (status, body) = app
        .patch("/commerce-settings", &json!({ "nextOrderNumber": current }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "SEQUENCE_BACKWARDS");
    assert!(
        body["error"]["details"]["current"]
            .as_i64()
            .expect("current")
            >= target
    );

    // The currency is upper-cased; invalid input is a 400.
    let (status, body) = app
        .patch("/commerce-settings", &json!({ "defaultCurrency": "eur" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["defaultCurrency"], "EUR");
    let (status, body) = app
        .patch("/commerce-settings", &json!({ "nextOrderNumber": 0 }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"]["issues"].is_array(), "{body}");

    let events = app.events().await;
    assert!(
        events
            .iter()
            .any(|e| e["eventType"] == "commerce_settings:updated"),
        "{events:?}"
    );
}
