//! WeldReach hooks into WeldHost (`lib/weldreach.ts`): a domain is connected
//! while its tenant has a `reach_domains` row for it that is not
//! `disconnecting`. Read with SQL against the tenant (WeldReach itself is
//! ported later); a tenant without the table has no connected domains.

use axum::response::Response;
use http::StatusCode;
use serde_json::Value;
use weldsuite_db::{PgPool, is_missing_table};

use crate::error_response;

const DOMAIN_IN_USE_MESSAGE: &str = "Disconnect this domain in WeldReach first.";
const DNS_RECORD_MANAGED_MESSAGE: &str =
    "This record is managed by WeldReach. Disconnect the domain in WeldReach first.";

/// 409 `DOMAIN_IN_USE_BY_WELDREACH`.
pub(crate) fn domain_in_use() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "DOMAIN_IN_USE_BY_WELDREACH",
        DOMAIN_IN_USE_MESSAGE,
    )
}

/// 409 `DNS_RECORD_MANAGED_BY_WELDREACH`.
pub(crate) fn record_managed() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "DNS_RECORD_MANAGED_BY_WELDREACH",
        DNS_RECORD_MANAGED_MESSAGE,
    )
}

/// `orNone`: a missing table reads as `fallback`.
fn or_none<T>(result: Result<T, sqlx::Error>, fallback: T) -> Result<T, sqlx::Error> {
    match result {
        Ok(value) => Ok(value),
        Err(error) if is_missing_table(&error) => Ok(fallback),
        Err(error) => Err(error),
    }
}

/// `connectedWeldReachDomainIds`.
pub(crate) async fn connected_domain_ids(
    db: &PgPool,
    domain_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if domain_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query_scalar::<_, String>(
        "select host_domain_id from reach_domains
         where host_domain_id = any($1) and status <> 'disconnecting'",
    )
    .bind(domain_ids)
    .fetch_all(db)
    .await;
    or_none(rows, Vec::new())
}

/// `isDomainUsedByWeldReach`.
pub(crate) async fn is_domain_used(db: &PgPool, domain_id: &str) -> Result<bool, sqlx::Error> {
    Ok(connected_domain_ids(db, &[domain_id.to_owned()])
        .await?
        .iter()
        .any(|id| id == domain_id))
}

/// `isDomainNameUsedByWeldReach`.
pub(crate) async fn is_domain_name_used(db: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    let row = sqlx::query_scalar::<_, String>(
        "select id from reach_domains where name = $1 and status <> 'disconnecting' limit 1",
    )
    .bind(crate::js::js_trim(name).to_lowercase())
    .fetch_optional(db)
    .await;
    or_none(row.map(|row| row.is_some()), false)
}

/// `weldReachDomainNameForZone`.
pub(crate) async fn domain_name_for_zone(
    db: &PgPool,
    zone_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "select z.name, r.id from dns_zones z
         left join reach_domains r on r.host_domain_id = z.domain_id and r.status <> 'disconnecting'
         where z.id = $1 limit 1",
    )
    .bind(zone_id)
    .fetch_optional(db)
    .await;
    or_none(
        row.map(|row| row.and_then(|(name, reach)| reach.map(|_| name))),
        None,
    )
}

fn strip_trailing_dot(name: &str) -> String {
    let lower = crate::js::js_trim(name).to_lowercase();
    lower.strip_suffix('.').map_or(lower.clone(), str::to_owned)
}

/// `toFqdn`.
fn to_fqdn(name: &str, domain_name: &str) -> String {
    let domain = strip_trailing_dot(domain_name);
    let record = strip_trailing_dot(name);
    if record.is_empty() || record == "@" || record == domain {
        return domain;
    }
    if record.ends_with(&format!(".{domain}")) {
        record
    } else {
        format!("{record}.{domain}")
    }
}

/// `isSpfValue`: `/^v=spf1(\s|$)/i` after the TXT quote.
fn is_spf(value: &str) -> bool {
    let trimmed = crate::js::js_trim(value);
    let unquoted = trimmed.strip_prefix('"').unwrap_or(trimmed);
    let text = crate::js::js_trim(unquoted);
    let Some(prefix) = text.get(..6) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("v=spf1") {
        return false;
    }
    text[6..].chars().next().is_none_or(char::is_whitespace)
}

/// `isWeldReachManagedRecord`.
pub(crate) fn is_managed_record(domain_name: &str, kind: &str, name: &str, value: &str) -> bool {
    let domain = strip_trailing_dot(domain_name);
    let fqdn = to_fqdn(name, &domain);
    let kind = kind.to_uppercase();
    if kind == "MX" {
        return fqdn == domain;
    }
    if kind != "TXT" {
        return false;
    }
    if fqdn == domain {
        return is_spf(value);
    }
    if fqdn == format!("_dmarc.{domain}") {
        return true;
    }
    let suffix = format!("._domainkey.{domain}");
    fqdn.ends_with(&suffix) && fqdn.len() > suffix.len()
}

/// `duplicatesWeldReachRecord`.
pub(crate) fn duplicates_record(domain_name: &str, kind: &str, name: &str, value: &str) -> bool {
    if kind.to_uppercase() != "TXT" {
        return false;
    }
    let domain = strip_trailing_dot(domain_name);
    let fqdn = to_fqdn(name, &domain);
    (fqdn == domain && is_spf(value)) || fqdn == format!("_dmarc.{domain}")
}

/// `markWeldReachRecords`: each record with `managedBy`.
pub(crate) async fn mark_records(
    db: &PgPool,
    records: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    let Some(first) = records.first() else {
        return Ok(Vec::new());
    };
    let zone_id = first
        .get("zoneId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let domain_name = domain_name_for_zone(db, &zone_id).await?;
    Ok(records
        .into_iter()
        .map(|mut record| {
            let field = |key: &str| record.get(key).map(crate::js::as_text).unwrap_or_default();
            let managed = domain_name.as_deref().is_some_and(|domain| {
                is_managed_record(domain, &field("type"), &field("name"), &field("value"))
            });
            if let Value::Object(fields) = &mut record {
                fields.insert(
                    "managedBy".to_owned(),
                    if managed {
                        Value::from("weldreach")
                    } else {
                        Value::Null
                    },
                );
            }
            record
        })
        .collect())
}

/// `sameNameservers`.
fn same_nameservers(a: Option<&Value>, b: Option<&Value>) -> bool {
    let list = |v: Option<&Value>| -> Vec<String> {
        let mut items: Vec<String> = v
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|i| strip_trailing_dot(&crate::js::as_text(i)))
                    .collect()
            })
            .unwrap_or_default();
        items.sort();
        items
    };
    list(a) == list(b)
}

/// `changesNameservers(existing, patch)`.
pub(crate) fn changes_nameservers(
    existing: &Value,
    patch: &serde_json::Map<String, Value>,
) -> bool {
    if let Some(nameservers) = patch.get("nameservers")
        && !same_nameservers(existing.get("nameservers"), Some(nameservers))
    {
        return true;
    }
    patch.get("customNameservers").is_some_and(|custom| {
        custom.as_bool() != Some(crate::js::truthy(existing.get("customNameservers")))
    })
}

/// `changesZoneRouting(existing, patch)`.
pub(crate) fn changes_zone_routing(
    existing: &Value,
    patch: &serde_json::Map<String, Value>,
) -> bool {
    if let Some(provider) = patch.get("provider")
        && Some(provider) != existing.get("provider")
    {
        return true;
    }
    if let Some(external) = patch.get("externalZoneId") {
        let current = existing
            .get("externalZoneId")
            .cloned()
            .unwrap_or(Value::Null);
        if *external != current {
            return true;
        }
    }
    patch.get("externalNameservers").is_some_and(|nameservers| {
        !same_nameservers(existing.get("externalNameservers"), Some(nameservers))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mailpool_records() {
        assert!(is_managed_record("acme.com", "MX", "@", "mx.mailpool.io"));
        assert!(is_managed_record(
            "acme.com",
            "TXT",
            "acme.com",
            "\"v=spf1 include:x ~all\""
        ));
        assert!(!is_managed_record(
            "acme.com",
            "TXT",
            "acme.com",
            "google-site-verification=1"
        ));
        assert!(is_managed_record(
            "acme.com",
            "TXT",
            "s1._domainkey",
            "v=DKIM1"
        ));
        assert!(!is_managed_record(
            "acme.com",
            "TXT",
            "_domainkey",
            "v=DKIM1"
        ));
        assert!(duplicates_record("acme.com", "txt", "_dmarc", "v=DMARC1"));
        assert!(!duplicates_record("acme.com", "A", "_dmarc", "1.2.3.4"));
    }

    #[test]
    fn nameserver_changes() {
        let existing =
            json!({ "nameservers": ["NS1.x.com.", "ns2.x.com"], "customNameservers": null });
        let same = json!({ "nameservers": ["ns2.x.com", "ns1.x.com"], "customNameservers": false });
        assert!(!changes_nameservers(
            &existing,
            same.as_object().expect("object")
        ));
        let changed = json!({ "customNameservers": true });
        assert!(changes_nameservers(
            &existing,
            changed.as_object().expect("object")
        ));
    }
}
