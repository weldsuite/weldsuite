//! `/api/discounts`: codes, validation, uniqueness, effective status,
//! soft delete and events.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, discount, fresh, ids, read, tenant};

#[tokio::test]
async fn create_read_update_and_delete() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let code = fresh("SPRING").to_uppercase();
    let id = discount(
        &app,
        &json!({ "name": "Spring", "code": &code, "type": "percentage", "value": "15", "status": "active" }),
    )
    .await;

    let row = read(&app, &format!("/discounts/{id}")).await;
    assert_eq!(row["code"], json!(code));
    assert_eq!(row["value"], "15.00");
    assert_eq!(row["usageCount"], 0);
    assert_eq!(row["effectiveStatus"], "active");
    assert_eq!(row["appliesTo"], "all");
    assert_eq!(row["productIds"], json!([]));
    assert_eq!(app.events_of("discount:created", &id).await.len(), 1);

    let (status, body) = app
        .patch(
            &format!("/discounts/{id}"),
            &json!({ "name": "Spring sale", "usageLimit": 5 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["name"], "Spring sale");
    assert_eq!(body["data"]["usageLimit"], 5);
    assert_eq!(app.events_of("discount:updated", &id).await.len(), 1);

    let list = read(&app, &format!("/discounts?search={code}")).await;
    assert_eq!(ids(&list), vec![id.clone()]);

    let (status, _) = app.delete(&format!("/discounts/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app.get(&format!("/discounts/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(app.events_of("discount:deleted", &id).await.len(), 1);
    // The code is free again.
    discount(
        &app,
        &json!({ "name": "Again", "code": code.to_lowercase(), "type": "percentage", "value": "5" }),
    )
    .await;
}

#[tokio::test]
async fn a_code_is_unique_ignoring_case_among_non_archived() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let code = fresh("Dup");
    let first = discount(
        &app,
        &json!({ "name": "A", "code": &code, "type": "percentage", "value": "10" }),
    )
    .await;

    let (status, body) = app
        .post(
            "/discounts",
            &json!({ "name": "B", "code": format!(" {} ", code.to_uppercase()), "type": "percentage", "value": "10" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CODE_TAKEN");
    assert_eq!(body["error"]["details"]["field"], "code");

    // Archiving frees the code; bringing the old one back then clashes.
    let (status, _) = app
        .patch(
            &format!("/discounts/{first}"),
            &json!({ "status": "archived" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let second = discount(
        &app,
        &json!({ "name": "B", "code": &code, "type": "percentage", "value": "10" }),
    )
    .await;
    let (status, body) = app
        .patch(
            &format!("/discounts/{first}"),
            &json!({ "status": "draft" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CODE_TAKEN");
    let (status, body) = app
        .patch(
            &format!("/discounts/{second}"),
            &json!({ "code": format!("OTHER-{code}") }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn validation_and_effective_status() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    for (body, field) in [
        (
            json!({ "name": "X", "code": fresh("V"), "type": "percentage", "value": "101" }),
            "value",
        ),
        (
            json!({ "name": "X", "code": fresh("V"), "type": "fixed_amount", "value": "5" }),
            "currency",
        ),
        (
            json!({ "name": "X", "code": fresh("V"), "type": "percentage", "value": "5", "appliesTo": "products" }),
            "productIds",
        ),
        (
            json!({ "name": "X", "code": fresh("V"), "type": "percentage", "value": "5",
                    "startsAt": "2030-01-02T00:00:00Z", "endsAt": "2030-01-01T00:00:00Z" }),
            "endsAt",
        ),
        (
            json!({ "name": "X", "type": "percentage", "value": "5" }),
            "code",
        ),
    ] {
        let (status, answer) = app.post("/discounts", &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {answer}");
        assert!(answer["error"]["issues"].is_array(), "{field}");
    }

    let scheduled = discount(
        &app,
        &json!({ "name": "Later", "code": fresh("L"), "type": "free_shipping", "value": "0",
                 "status": "active", "startsAt": "2099-01-01T00:00:00Z" }),
    )
    .await;
    let expired = discount(
        &app,
        &json!({ "name": "Gone", "code": fresh("G"), "type": "percentage", "value": "5",
                 "status": "active", "endsAt": "2020-01-01T00:00:00Z" }),
    )
    .await;
    let draft = discount(
        &app,
        &json!({ "name": "Draft", "code": fresh("D"), "type": "percentage", "value": "5" }),
    )
    .await;
    let used = discount(
        &app,
        &json!({ "name": "Used", "code": fresh("U"), "type": "percentage", "value": "5",
                 "status": "active", "usageLimit": 1 }),
    )
    .await;
    // The order writes bump the counter; here the row is set directly.
    sqlx::query("update discounts set usage_count = 1 where id = $1")
        .bind(&used)
        .execute(&db)
        .await
        .expect("usage");
    for (id, want) in [
        (&scheduled, "scheduled"),
        (&expired, "expired"),
        (&draft, "draft"),
        (&used, "used_up"),
    ] {
        assert_eq!(
            read(&app, &format!("/discounts/{id}")).await["effectiveStatus"],
            want
        );
        let filtered = read(
            &app,
            &format!("/discounts?effectiveStatus={want}&limit=100"),
        )
        .await;
        assert!(ids(&filtered).contains(id), "{want}");
    }
    let row = read(&app, &format!("/discounts/{scheduled}")).await;
    assert_eq!(row["value"], "0.00");
}
