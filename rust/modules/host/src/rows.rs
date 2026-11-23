//! The tables' rows as Drizzle returns them (`select().from(...)`), and the
//! public shape of a domain (`toPublicDomain`).

use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_schema::tenant::{dns_records, dns_zones, domains};

/// A row as the API returns it: Drizzle's JSON shape, decided by the entity.
pub(crate) fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// [`js`] of a row that may be missing.
pub(crate) fn js_option<M: serde::Serialize>(model: Option<M>) -> Result<Option<Value>, DbErr> {
    model.map(js).transpose()
}

/// `$n::timestamp` of a `toISOString()` the route wrote: its UTC wall
/// clock. A text Postgres can't read is the failed cast (the route's 500).
pub(crate) fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(iso, &Rfc3339)
        .map(utc_timestamp)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })
}

/// `getDomain`: a live domain.
pub(crate) async fn live_domain(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = domains::Entity::find_by_id(id.to_owned())
        .filter(domains::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A domain, deleted or not.
pub(crate) async fn any_domain(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = domains::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A live zone by id (`getDnsZone`).
pub(crate) async fn live_zone(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = dns_zones::Entity::find_by_id(id.to_owned())
        .filter(dns_zones::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A zone, deleted or not.
pub(crate) async fn any_zone(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = dns_zones::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A domain's live zone (`getDnsZoneByDomain`).
pub(crate) async fn live_zone_of_domain(
    db: &PgPool,
    domain_id: &str,
) -> Result<Option<Value>, DbErr> {
    let row = dns_zones::Entity::find()
        .filter(dns_zones::Column::DomainId.eq(domain_id))
        .filter(dns_zones::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A record by id (`loadDnsRecordWithZone`'s first read).
pub(crate) async fn any_record(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = dns_records::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A zone's records (`select().from(hostDnsRecords).where(eq(zoneId))`).
pub(crate) async fn zone_records(db: &PgPool, zone_id: &str) -> Result<Vec<Value>, DbErr> {
    dns_records::Entity::find()
        .filter(dns_records::Column::ZoneId.eq(zone_id))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect()
}

/// `getDomainWithZone`: a live domain and the first zone the join finds
/// (deleted zones included, as the TypeScript join has no filter on them).
pub(crate) async fn domain_with_zone(
    db: &PgPool,
    id: &str,
) -> Result<Option<(Value, Option<Value>)>, DbErr> {
    let zone: RelationDef = domains::Entity::belongs_to(dns_zones::Entity)
        .from(domains::Column::Id)
        .to(dns_zones::Column::DomainId)
        .into();
    let row = domains::Entity::find()
        .select_also(dns_zones::Entity)
        .join(JoinType::LeftJoin, zone)
        .filter(domains::Column::Id.eq(id))
        .filter(domains::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    row.map(|(domain, zone)| Ok((js(domain)?, js_option(zone)?)))
        .transpose()
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
