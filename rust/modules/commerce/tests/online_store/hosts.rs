//! Free addresses and custom domains in the master registry.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, env, fresh};

#[tokio::test]
async fn a_free_address_is_live_at_once_and_unique() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site, _) = staff.site().await;
    let (status, config) = staff.get("/storefront-hosts/config").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(config["data"]["baseDomain"], env.base.as_str());
    assert_eq!(config["data"]["customDomains"], false);

    let label = fresh("shop");
    let (status, host) = staff
        .post(
            "/storefront-hosts",
            &json!({ "siteId": site, "subdomain": label }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{host}");
    let host = &host["data"];
    assert_eq!(host["hostname"], format!("{label}.{}", env.base));
    assert_eq!(host["status"], "active");
    assert_eq!(host["isPrimary"], true);
    assert_eq!(host["url"], format!("https://{label}.{}", env.base));

    // Another shop can't take it; a second free address is refused; reserved
    // labels and custom domains (not offered here) answer as such.
    let (other, _) = staff.site().await;
    let (status, taken) = staff
        .post(
            "/storefront-hosts",
            &json!({ "siteId": other, "subdomain": label }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{taken}");
    assert_eq!(taken["error"]["code"], "HOST_TAKEN");
    let (status, second) = staff
        .post(
            "/storefront-hosts",
            &json!({ "siteId": site, "subdomain": fresh("x") }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{second}");
    let (status, reserved) = staff
        .post(
            "/storefront-hosts",
            &json!({ "siteId": other, "subdomain": "admin" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{reserved}");
    assert_eq!(reserved["error"]["code"], "HOST_RESERVED");
    let (status, _) = staff
        .post(
            "/storefront-hosts",
            &json!({ "siteId": other, "hostname": "shop.example.com" }),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // The site shows it; the registry mirrors the site's state.
    let (_, detail) = staff.get(&format!("/online-store/sites/{site}")).await;
    assert_eq!(
        detail["data"]["primaryHost"],
        format!("{label}.{}", env.base)
    );
    let (status, _) = staff
        .patch(
            &format!("/online-store/sites/{site}"),
            &json!({ "visibility": "coming_soon" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let visibility: String =
        sqlx::query_scalar("select visibility from storefront_hosts where hostname = $1")
            .bind(format!("{label}.{}", env.base))
            .fetch_one(&env.master)
            .await
            .unwrap();
    assert_eq!(visibility, "coming_soon");

    let id = host["id"].as_str().unwrap();
    let (status, _) = staff.delete(&format!("/storefront-hosts/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, list) = staff.get(&format!("/storefront-hosts?siteId={site}")).await;
    assert_eq!(list["data"].as_array().unwrap().len(), 0);
}
