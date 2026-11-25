//! Sites, drafts, publishing, versions, pages, menus and redirects.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, env};

#[tokio::test]
async fn a_site_starts_from_the_theme_and_saves_drafts_by_revision() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site, channel) = staff.site().await;
    let (status, detail) = staff.get(&format!("/online-store/sites/{site}")).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let data = &detail["data"];
    assert_eq!(data["channelId"], channel);
    assert_eq!(data["locale"], "nl");
    assert_eq!(data["mode"], "builder");
    assert_eq!(data["draftRevision"], 0);
    assert_eq!(data["hasUnpublishedChanges"], true);
    assert_eq!(data["draft"]["theme"]["id"], "atelier");
    assert!(
        data["draft"]["templates"]["product"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["type"] == "main-product")
    );

    // One site per channel.
    let (status, again) = staff
        .post("/online-store/sites", &json!({ "channelId": channel }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(again["error"]["code"], "SITE_EXISTS");

    // A stale revision is refused with the current one.
    let mut draft = data["draft"].clone();
    draft["seo"]["title"] = json!("My shop");
    let (status, stale) = staff
        .put(
            &format!("/online-store/sites/{site}/draft"),
            &json!({ "document": draft, "revision": 5 }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["error"]["details"]["currentRevision"], 0);

    // An invalid document says where.
    let mut broken = draft.clone();
    broken["templates"]["home"] =
        json!([{ "id": "x", "type": "hero", "settings": { "buttonLink": "javascript:alert(1)" } }]);
    let (status, invalid) = staff
        .put(
            &format!("/online-store/sites/{site}/draft"),
            &json!({ "document": broken, "revision": 0 }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
    assert!(
        invalid["error"]["details"]["fields"]["document.templates.home[0].settings.buttonLink"]
            .is_string(),
        "{invalid}"
    );

    let (status, saved) = staff
        .put(
            &format!("/online-store/sites/{site}/draft"),
            &json!({ "document": draft, "revision": 0 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["data"]["draftRevision"], 1);
}

#[tokio::test]
async fn publishing_snapshots_pages_menus_and_redirects() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site, _) = staff.site().await;

    let (status, page) = staff
        .post(
            &format!("/online-store/sites/{site}/pages"),
            &json!({ "title": "Algemene voorwaarden", "sections": [{ "id": "text", "type": "rich-text", "settings": { "text": "## Wie wij zijn" } }] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{page}");
    assert_eq!(page["data"]["slug"], "algemene-voorwaarden");
    let page_id = page["data"]["id"].as_str().unwrap().to_owned();

    // A main section can't go on a content page; a taken slug is refused.
    let (status, _) = staff
        .post(&format!("/online-store/sites/{site}/pages"), &json!({ "title": "X", "sections": [{ "id": "m", "type": "main-product", "settings": {} }] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, taken) = staff
        .post(
            &format!("/online-store/sites/{site}/pages"),
            &json!({ "title": "Other", "slug": "algemene-voorwaarden" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{taken}");

    let (status, menu) = staff
        .put(
            &format!("/online-store/sites/{site}/menus/footer"),
            &json!({ "title": "Footer", "items": [{ "id": "terms", "label": "Voorwaarden", "link": { "type": "page", "id": page_id } }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{menu}");
    let (status, _) = staff
        .delete(&format!("/online-store/sites/{site}/menus/main"))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, redirect) = staff
        .post(
            &format!("/online-store/sites/{site}/redirects"),
            &json!({ "fromPath": "/old-terms", "toPath": "/pages/algemene-voorwaarden" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{redirect}");

    let (status, first) = staff
        .post(
            &format!("/online-store/sites/{site}/publish"),
            &json!({ "note": "Launch" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    assert_eq!(first["data"]["number"], 1);
    assert_eq!(first["data"]["isLive"], true);
    assert_eq!(first["data"]["site"]["hasUnpublishedChanges"], false);
    let first_id = first["data"]["id"].as_str().unwrap().to_owned();

    let document: Value =
        sqlx::query_scalar("select document from storefront_site_versions where id = $1")
            .bind(&first_id)
            .fetch_one(&env.tenant)
            .await
            .unwrap();
    assert_eq!(document["pages"][0]["slug"], "algemene-voorwaarden");
    assert_eq!(
        document["menus"]["footer"]["items"][0]["link"]["id"],
        page_id.as_str()
    );
    assert_eq!(
        document["menus"]["main"]["items"][0]["link"]["type"],
        "home"
    );
    assert_eq!(document["redirects"][0]["fromPath"], "/old-terms");

    // A hidden page leaves the next version.
    let (status, _) = staff
        .patch(
            &format!("/online-store/sites/{site}/pages/{page_id}"),
            &json!({ "visible": false }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, second) = staff
        .post(&format!("/online-store/sites/{site}/publish"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(second["data"]["number"], 2);

    let (status, versions) = staff
        .get(&format!("/online-store/sites/{site}/versions"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let versions = versions["data"].as_array().unwrap().clone();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0]["number"], 2);
    assert_eq!(versions[0]["isLive"], true);

    // Restoring the first makes it live again.
    let (status, restored) = staff
        .post(
            &format!("/online-store/sites/{site}/versions/{first_id}/restore"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["data"]["publishedVersionNumber"], 1);

    let events = staff.events().await;
    let published = events
        .iter()
        .filter(|e| e["eventType"] == "storefront_site:published")
        .count();
    assert_eq!(published, 2, "{events:?}");
    assert!(
        events
            .iter()
            .any(|e| e["eventType"] == "storefront_site:restored")
    );
    assert!(
        events
            .iter()
            .any(|e| e["eventType"] == "storefront_page:created")
    );
}

#[tokio::test]
async fn visibility_and_passwords() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site, _) = staff.site().await;
    let (status, refused) = staff
        .patch(
            &format!("/online-store/sites/{site}"),
            &json!({ "visibility": "password" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (status, locked) = staff
        .patch(
            &format!("/online-store/sites/{site}"),
            &json!({ "visibility": "password", "password": "open sesame" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{locked}");
    assert_eq!(locked["data"]["hasPassword"], true);
    assert!(locked["data"].get("passwordHash").is_none());

    let editor = env.staff(&["websites:read", "websites:update"]);
    let (status, _) = editor
        .patch(
            &format!("/online-store/sites/{site}"),
            &json!({ "visibility": "live" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
