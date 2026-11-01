//! The tables' rows as Drizzle returns them (`select().from(...)`), and the
//! public shape of a domain (`toPublicDomain`).

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};

/// One row of a `select to_jsonb(t) …` statement, Drizzle-shaped.
pub(crate) async fn one(
    db: &PgPool,
    sql: &'static str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(js_row))
}

/// Every row of a `select to_jsonb(t) …` statement with one parameter.
pub(crate) async fn all(
    db: &PgPool,
    sql: &'static str,
    id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(id).fetch_all(db).await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `getDomain`: a live domain.
pub(crate) async fn live_domain(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    one(
        db,
        "select to_jsonb(t) from domains t where t.id = $1 and t.deleted_at is null limit 1",
        id,
    )
    .await
}

/// A domain, deleted or not.
pub(crate) async fn any_domain(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    one(
        db,
        "select to_jsonb(t) from domains t where t.id = $1 limit 1",
        id,
    )
    .await
}

/// A live zone by id (`getDnsZone`).
pub(crate) async fn live_zone(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    one(
        db,
        "select to_jsonb(t) from dns_zones t where t.id = $1 and t.deleted_at is null limit 1",
        id,
    )
    .await
}

/// A zone, deleted or not.
pub(crate) async fn any_zone(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    one(
        db,
        "select to_jsonb(t) from dns_zones t where t.id = $1 limit 1",
        id,
    )
    .await
}

/// A domain's live zone (`getDnsZoneByDomain`).
pub(crate) async fn live_zone_of_domain(
    db: &PgPool,
    domain_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    one(
        db,
        "select to_jsonb(t) from dns_zones t where t.domain_id = $1 and t.deleted_at is null limit 1",
        domain_id,
    )
    .await
}

/// A zone's records (`select().from(hostDnsRecords).where(eq(zoneId))`).
pub(crate) async fn zone_records(db: &PgPool, zone_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    all(
        db,
        "select to_jsonb(t) from dns_records t where t.zone_id = $1",
        zone_id,
    )
    .await
}

/// `getDomainWithZone`: a live domain and the first zone the join finds
/// (deleted zones included, as the TypeScript join has no filter on them).
pub(crate) async fn domain_with_zone(
    db: &PgPool,
    id: &str,
) -> Result<Option<(Value, Option<Value>)>, sqlx::Error> {
    let row: Option<(Value, Option<Value>)> = sqlx::query_as(
        "select to_jsonb(d), to_jsonb(z) from domains d
         left join dns_zones z on z.domain_id = d.id
         where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(domain, zone)| (js_row(domain), zone.filter(|z| !z.is_null()).map(js_row))))
}

/// Registrars WeldSuite operates; customers see `WeldSuite` instead.
const MANAGED_DOMAIN_REGISTRARS: [&str; 4] =
    ["realtimeregister", "cloudflare", "WeldHost", "WeldSuite"];

/// `isManagedDomainRegistrar`.
fn is_managed_registrar(registrar: Option<&str>) -> bool {
    registrar.is_none_or(|r| r.is_empty() || MANAGED_DOMAIN_REGISTRARS.contains(&r))
}

/// `isExternalDomainRegistrar`.
pub(crate) fn is_external_registrar(registrar: Option<&str>) -> bool {
    registrar.is_some_and(|r| !r.is_empty()) && !is_managed_registrar(registrar)
}

/// `toPublicDomain`: the row with its registrar as customers see it.
pub(crate) fn public_domain(mut row: Value) -> Value {
    let registrar = row
        .get("registrar")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let public = if is_managed_registrar(registrar.as_deref()) {
        "WeldSuite".to_owned()
    } else {
        registrar.unwrap_or_default()
    };
    if let Value::Object(fields) = &mut row {
        fields.insert("registrar".to_owned(), json!(public));
    }
    row
}

/// `isHiddenUnpaidDomain`.
pub(crate) fn is_hidden_unpaid(row: &Value) -> bool {
    let registration = row.get("registrationStatus").and_then(Value::as_str);
    if registration == Some("pending_payment") {
        return true;
    }
    row.get("status").and_then(Value::as_str) == Some("cancelled") && registration == Some("failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrars_are_public() {
        assert_eq!(
            public_domain(json!({ "registrar": "realtimeregister" }))["registrar"],
            "WeldSuite"
        );
        assert_eq!(
            public_domain(json!({ "registrar": null }))["registrar"],
            "WeldSuite"
        );
        assert_eq!(
            public_domain(json!({ "registrar": "GoDaddy" }))["registrar"],
            "GoDaddy"
        );
        assert!(is_external_registrar(Some("GoDaddy")));
        assert!(!is_external_registrar(Some("cloudflare")));
        assert!(!is_external_registrar(None));
    }
}
