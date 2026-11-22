//! Shipping rates: countries within the channel's, its currency, order.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, ids, read, tenant};

#[tokio::test]
async fn create_edit_reorder_and_delete() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let channel = app.storefront().await;
    let path = format!("/commerce-channels/{channel}/shipping-rates");

    let (status, body) = app
        .post(
            &path,
            &json!({ "zoneName": "Benelux", "countries": ["NL"], "name": "Standard", "price": 4.95, "freeShippingThreshold": "50" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first = body["data"]["id"].as_str().unwrap().to_owned();
    let (_, body) = app
        .post(
            &path,
            &json!({ "zoneName": "Germany", "countries": ["DE"], "name": "Express", "price": "9.5" }),
        )
        .await;
    let second = body["data"]["id"].as_str().unwrap().to_owned();
    let (_, body) = app
        .post(
            &path,
            &json!({ "zoneName": "Both", "countries": ["NL", "DE"], "name": "Pickup", "price": "0", "active": false }),
        )
        .await;
    let third = body["data"]["id"].as_str().unwrap().to_owned();

    let rates = read(&app, &path).await;
    assert_eq!(
        ids(&rates),
        vec![first.clone(), second.clone(), third.clone()]
    );
    assert_eq!(rates[0]["price"], "4.95");
    assert_eq!(rates[0]["currency"], "EUR");
    assert_eq!(rates[0]["freeShippingThreshold"], "50.00");
    assert_eq!(rates[0]["position"], 0);
    assert_eq!(rates[1]["price"], "9.50");
    assert_eq!(rates[1]["freeShippingThreshold"], json!(null));
    assert_eq!(rates[2]["active"], false);
    assert_eq!(rates[0]["channelId"], json!(channel));
    assert_eq!(
        app.events_of("commerce_shipping_rate:created", &first)
            .await
            .len(),
        1
    );

    let (status, body) = app
        .patch(
            &format!("{path}/{first}"),
            &json!({ "name": "Standard plus", "price": "5.25", "freeShippingThreshold": null }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["name"], "Standard plus");
    assert_eq!(body["data"]["price"], "5.25");
    assert_eq!(body["data"]["freeShippingThreshold"], json!(null));
    assert_eq!(body["data"]["countries"], json!(["NL"]));
    assert_eq!(
        app.events_of("commerce_shipping_rate:updated", &first)
            .await
            .len(),
        1
    );

    // Reorder: no body back; unknown or repeated ids are refused.
    let (status, body) = app
        .put(
            &format!("{path}/order"),
            &json!({ "ids": [third, first, second] }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        ids(&read(&app, &path).await),
        vec![third.clone(), first.clone(), second.clone()]
    );
    let (status, _) = app
        .put(&format!("{path}/order"), &json!({ "ids": [first, "nope"] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app
        .put(&format!("{path}/order"), &json!({ "ids": [first, first] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.put(&format!("{path}/order"), &json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A new rate goes last.
    let (_, body) = app
        .post(
            &path,
            &json!({ "zoneName": "Z", "countries": ["NL"], "name": "Last", "price": "1" }),
        )
        .await;
    let last = body["data"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ids(&read(&app, &path).await).last(), Some(&last));

    let (status, _) = app.delete(&format!("{path}/{second}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!ids(&read(&app, &path).await).contains(&second));
    assert_eq!(
        app.events_of("commerce_shipping_rate:deleted", &second)
            .await
            .len(),
        1
    );
    let (status, _) = app.delete(&format!("{path}/{second}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .patch(&format!("{path}/{second}"), &json!({ "name": "x" }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn countries_stay_within_what_the_channel_sells() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let channel = app.storefront().await;
    let path = format!("/commerce-channels/{channel}/shipping-rates");
    for body in [
        // FR is an EU country, but this channel sells to NL and DE only.
        json!({ "zoneName": "Z", "countries": ["FR"], "name": "N", "price": "1" }),
        json!({ "zoneName": "Z", "countries": [], "name": "N", "price": "1" }),
        json!({ "zoneName": "Z", "countries": ["NLD"], "name": "N", "price": "1" }),
        json!({ "zoneName": "Z", "countries": ["NL"], "name": "N", "price": "-1" }),
        json!({ "zoneName": "Z", "countries": ["NL"], "name": "N" }),
        json!({ "countries": ["NL"], "name": "N", "price": "1" }),
    ] {
        let (status, answer) = app.post(&path, &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }
    let (_, created) = app
        .post(
            &path,
            &json!({ "zoneName": "Z", "countries": ["NL"], "name": "N", "price": "1" }),
        )
        .await;
    let rate = created["data"]["id"].as_str().unwrap();
    let (status, body) = app
        .patch(
            &format!("{path}/{rate}"),
            &json!({ "countries": ["NL", "BE"] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = app.get("/commerce-channels/missing/shipping-rates").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
