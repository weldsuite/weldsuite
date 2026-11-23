//! `lib/host-dns-sync.ts`: pull a zone's live record set from the DNS host
//! and reconcile `dns_records` to it, and the record locks (a user's, and
//! the ones WeldMail's domains need).

use std::collections::HashMap;

use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::enums::{HostDnsRecordStatus, HostDnsRecordType};
use weldsuite_schema::tenant::{dns_records, dns_zones, mail_domains};

use crate::dns_host::{Dns, DnsRecord};
use crate::js::{as_text, slice_utf16, text};
use crate::now;
use crate::rows::zone_records;

/// `SyncResult`.
#[derive(Debug, Clone, Default)]
pub(crate) struct SyncResult {
    pub(crate) ok: bool,
    pub(crate) records: Vec<Value>,
    pub(crate) error: Option<String>,
    pub(crate) added: u64,
    pub(crate) updated: u64,
    pub(crate) removed: u64,
}

/// `MappedRecord`.
struct Mapped {
    external_id: String,
    kind: String,
    name: String,
    value: String,
    ttl: Value,
    priority: Value,
    weight: Value,
    port: Value,
    caa_flag: Value,
    caa_tag: Value,
    comment: Value,
}

/// `a ?? b` for JSON.
fn or_value(a: Option<&Value>, b: Value) -> Value {
    match a {
        Some(value) if !value.is_null() => value.clone(),
        _ => b,
    }
}

fn data_field(data: &Value, key: &str) -> Value {
    or_value(data.get(key), Value::Null)
}

/// `mapCloudflareRecord`: `None` for the types the zones client can't edit.
fn map_record(r: &DnsRecord) -> Option<Mapped> {
    let kind = r.editable_type.clone()?;
    Some(Mapped {
        external_id: r.id.clone(),
        kind,
        name: r.name.clone(),
        value: r.content.clone(),
        ttl: or_value(Some(&r.ttl), json!(3600)),
        priority: or_value(Some(&r.priority), data_field(&r.data, "priority")),
        weight: data_field(&r.data, "weight"),
        port: data_field(&r.data, "port"),
        caa_flag: data_field(&r.data, "flags"),
        caa_tag: data_field(&r.data, "tag"),
        comment: or_value(Some(&r.comment), Value::Null),
    })
}

/// JavaScript's `!==` between two column values (numbers by value).
fn differs(a: Option<&Value>, b: &Value) -> bool {
    let a = a.unwrap_or(&Value::Null);
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() != y.as_f64(),
        _ => a != b,
    }
}

/// `hasRecordDrift`.
fn has_drift(local: &Value, m: &Mapped) -> bool {
    differs(local.get("type"), &json!(m.kind))
        || differs(local.get("name"), &json!(m.name))
        || differs(local.get("value"), &json!(m.value))
        || differs(local.get("ttl"), &m.ttl)
        || differs(local.get("priority"), &m.priority)
        || differs(local.get("weight"), &m.weight)
        || differs(local.get("port"), &m.port)
        || differs(local.get("caaFlag"), &m.caa_flag)
        || differs(local.get("caaTag"), &m.caa_tag)
        || differs(local.get("comment"), &m.comment)
        || text(local, "status") != Some("active")
        || !local.get("syncError").is_none_or(Value::is_null)
}

/// An integer column's value.
#[allow(clippy::cast_possible_truncation)]
fn int(value: &Value) -> Option<i32> {
    value.as_f64().map(|n| n as i32)
}

/// `ttl`, which the column requires: a null is the failed insert or update.
fn ttl(value: &Value) -> Result<i32, DbErr> {
    int(value).ok_or_else(|| {
        DbErr::Custom(
            "null value in column \"ttl\" of relation \"dns_records\" violates not-null constraint"
                .to_owned(),
        )
    })
}

/// The mapped record's columns, as the insert and the drift update write them.
fn record_columns(m: &Mapped, at: PrimitiveDateTime) -> Result<dns_records::ActiveModel, DbErr> {
    Ok(dns_records::ActiveModel {
        type_: Set(HostDnsRecordType::try_from_value(&m.kind)?),
        name: Set(m.name.clone()),
        value: Set(m.value.clone()),
        ttl: Set(ttl(&m.ttl)?),
        priority: Set(int(&m.priority)),
        weight: Set(int(&m.weight)),
        port: Set(int(&m.port)),
        caa_flag: Set(int(&m.caa_flag)),
        caa_tag: Set(optional_text(&m.caa_tag)),
        comment: Set(optional_text(&m.comment)),
        status: Set(HostDnsRecordStatus::Active),
        synced_at: Set(Some(at)),
        sync_error: Set(None),
        ..Default::default()
    })
}

fn optional_text(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| as_text(value))
}

/// `reconcileRecord`: insert, update or touch the local row.
async fn reconcile(
    db: &PgPool,
    zone_id: &str,
    m: &Mapped,
    local: Option<&Value>,
    at: PrimitiveDateTime,
) -> Result<&'static str, DbErr> {
    let Some(local) = local else {
        let record = dns_records::ActiveModel {
            id: Set(generate_id("dnsrec")),
            zone_id: Set(zone_id.to_owned()),
            external_record_id: Set(Some(m.external_id.clone())),
            ..record_columns(m, at)?
        };
        dns_records::Entity::insert(record)
            .exec_without_returning(&orm(db))
            .await?;
        return Ok("added");
    };
    let id = text(local, "id").unwrap_or_default();
    if has_drift(local, m) {
        let record = dns_records::ActiveModel {
            updated_at: Set(at),
            ..record_columns(m, at)?
        };
        dns_records::Entity::update_many()
            .set(record)
            .filter(dns_records::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
        return Ok("updated");
    }
    dns_records::Entity::update_many()
        .set(dns_records::ActiveModel {
            synced_at: Set(Some(at)),
            ..Default::default()
        })
        .filter(dns_records::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok("unchanged")
}

/// `syncZoneRecordsFromCloudflare(db, apiToken, zone)`.
#[allow(clippy::too_many_lines)] // list, reconcile, prune, locks
pub(crate) async fn sync_zone(
    db: &PgPool,
    dns: &Dns,
    zone_id: &str,
    external_zone_id: Option<&str>,
) -> Result<SyncResult, DbErr> {
    let Some(external) = external_zone_id.filter(|id| !id.is_empty()) else {
        return Ok(SyncResult {
            error: Some("Zone has no Cloudflare zone id".to_owned()),
            ..SyncResult::default()
        });
    };
    let listed = match dns.list_records(external).await {
        Ok(records) => records,
        Err(error) => {
            tracing::error!(%error, "[host-dns-sync] listDnsRecordsInZone failed");
            let at = utc_now();
            dns_zones::Entity::update_many()
                .set(dns_zones::ActiveModel {
                    sync_error: Set(Some(slice_utf16(&error.message, 1000))),
                    synced_at: Set(Some(at)),
                    updated_at: Set(at),
                    ..Default::default()
                })
                .filter(dns_zones::Column::Id.eq(zone_id))
                .exec(&orm(db))
                .await?;
            return Ok(SyncResult {
                records: zone_records(db, zone_id).await?,
                error: Some(error.message),
                ..SyncResult::default()
            });
        }
    };
    let existing = zone_records(db, zone_id).await?;
    let mut by_external: HashMap<String, &Value> = HashMap::new();
    let mut without_external: Vec<&Value> = Vec::new();
    for row in &existing {
        match text(row, "externalRecordId").filter(|id| !id.is_empty()) {
            Some(external) => {
                by_external.insert(external.to_owned(), row);
            }
            None => without_external.push(row),
        }
    }
    let mapped: Vec<Mapped> = listed.iter().filter_map(map_record).collect();
    let at = utc_now();
    let mut seen: Vec<String> = Vec::new();
    let (mut added, mut updated) = (0, 0);
    for m in &mapped {
        seen.push(m.external_id.clone());
        match reconcile(
            db,
            zone_id,
            m,
            by_external.get(&m.external_id).copied(),
            at,
        )
        .await?
        {
            "added" => added += 1,
            "updated" => updated += 1,
            _ => {}
        }
    }
    // `pruneStaleRecords`.
    let mut stale: Vec<String> = existing
        .iter()
        .filter(|row| {
            text(row, "externalRecordId")
                .filter(|id| !id.is_empty())
                .is_some_and(|id| !seen.iter().any(|s| s == id))
        })
        .filter_map(|row| text(row, "id").map(str::to_owned))
        .collect();
    stale.extend(
        without_external
            .iter()
            .filter_map(|row| text(row, "id").map(str::to_owned)),
    );
    let removed = stale.len() as u64;
    if !stale.is_empty() {
        dns_records::Entity::delete_many()
            .filter(dns_records::Column::Id.is_in(stale))
            .exec(&orm(db))
            .await?;
    }
    dns_zones::Entity::update_many()
        .set(dns_zones::ActiveModel {
            synced_at: Set(Some(at)),
            sync_error: Set(None),
            record_count: Set(Some(i32::try_from(mapped.len()).unwrap_or(i32::MAX))),
            updated_at: Set(at),
            ..Default::default()
        })
        .filter(dns_zones::Column::Id.eq(zone_id))
        .exec(&orm(db))
        .await?;
    // `reconcileSystemLocks`: failures are logged, never returned.
    let zone_name: Result<Option<String>, DbErr> = dns_zones::Entity::find_by_id(zone_id.to_owned())
        .select_only()
        .column(dns_zones::Column::Name)
        .into_tuple()
        .one(&orm(db))
        .await;
    match zone_name {
        Ok(Some(name)) => {
            if let Err(error) = detect_system_locks(db, zone_id, &name).await {
                tracing::error!(%error, "[host-dns-sync] detectSystemLocksForZone failed");
            }
        }
        Ok(None) => {}
        Err(error) => tracing::error!(%error, "[host-dns-sync] detectSystemLocksForZone failed"),
    }
    Ok(SyncResult {
        ok: true,
        records: zone_records(db, zone_id).await?,
        error: None,
        added,
        updated,
        removed,
    })
}

// ── Record locks ────────────────────────────────────────────────────────────

/// `getRecordLocks`: the well-formed locks in `metadata.locks`.
pub(crate) fn record_locks(metadata: Option<&Value>) -> Vec<Value> {
    metadata
        .and_then(|m| m.get("locks"))
        .and_then(Value::as_array)
        .map(|locks| {
            locks
                .iter()
                .filter(|l| {
                    l.get("source").is_some_and(Value::is_string)
                        && l.get("reason").is_some_and(Value::is_string)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn source(lock: &Value) -> Option<&str> {
    lock.get("source").and_then(Value::as_str)
}

/// `setLocksOnMetadata`.
fn with_locks(metadata: Option<&Value>, locks: Vec<Value>) -> Value {
    let mut next: Map<String, Value> = metadata
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if locks.is_empty() {
        next.remove("locks");
    } else {
        next.insert("locks".to_owned(), Value::Array(locks));
    }
    Value::Object(next)
}

/// `addUserLock`.
pub(crate) fn add_user_lock(metadata: Option<&Value>, reason: &str) -> Value {
    let mut locks: Vec<Value> = record_locks(metadata)
        .into_iter()
        .filter(|l| source(l) != Some("user"))
        .collect();
    locks.push(json!({ "source": "user", "reason": reason, "lockedAt": now() }));
    with_locks(metadata, locks)
}

/// `removeUserLock`.
pub(crate) fn remove_user_lock(metadata: Option<&Value>) -> Value {
    let locks = record_locks(metadata)
        .into_iter()
        .filter(|l| source(l) != Some("user"))
        .collect();
    with_locks(metadata, locks)
}

fn lock_key(kind: &Value, name: &Value) -> String {
    let name = as_text(name).to_lowercase();
    let name = name.strip_suffix('.').unwrap_or(&name).to_owned();
    format!("{}|{name}", as_text(kind).to_uppercase())
}

fn weldmail_reason(purpose: &str, domain: &str) -> String {
    match purpose {
        "mx" => format!(
            "Required by WeldMail for inbound email on {domain}. Removing it will break email delivery."
        ),
        "spf" => format!(
            "Required by WeldMail (SPF) on {domain}. Removing it will cause outbound mail to be marked as spam."
        ),
        "dkim" => format!(
            "Required by WeldMail (DKIM) on {domain}. Removing it will cause outbound mail to fail authentication."
        ),
        "dmarc" => format!(
            "Required by WeldMail (DMARC) on {domain}. Removing it weakens email authentication."
        ),
        "verification" => format!("Required by WeldMail to verify ownership of {domain}."),
        other => format!("Required by WeldMail ({other}) on {domain}."),
    }
}

fn same_lock(a: &Value, b: &Value) -> bool {
    a.get("source") == b.get("source")
        && a.get("sourceId") == b.get("sourceId")
        && a.get("purpose") == b.get("purpose")
}

/// `detectSystemLocksForZone`.
pub(crate) async fn detect_system_locks(
    db: &PgPool,
    zone_id: &str,
    zone_name: &str,
) -> Result<(), DbErr> {
    let records = zone_records(db, zone_id).await?;
    let mail_domains: Vec<(String, String, Option<Value>)> = mail_domains::Entity::find()
        .select_only()
        .columns([
            mail_domains::Column::Id,
            mail_domains::Column::DomainName,
            mail_domains::Column::DnsRecords,
        ])
        .filter(mail_domains::Column::DomainName.eq(zone_name))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut expected: HashMap<String, Vec<Value>> = HashMap::new();
    for (id, domain_name, dns_records) in &mail_domains {
        let list = dns_records
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for r in list {
            let Some(purpose) = r.get("purpose").filter(|p| crate::js::truthy(Some(p))) else {
                continue;
            };
            let purpose = as_text(purpose);
            let key = lock_key(&r["type"], &r["name"]);
            expected.entry(key).or_default().push(json!({
                "source": "weldmail",
                "sourceId": id,
                "purpose": purpose,
                "reason": weldmail_reason(&purpose, domain_name),
                "lockedAt": now(),
            }));
        }
    }
    for record in &records {
        let wanted = expected
            .get(&lock_key(&record["type"], &record["name"]))
            .cloned()
            .unwrap_or_default();
        let current = record_locks(record.get("metadata"));
        let user: Vec<Value> = current
            .iter()
            .filter(|l| source(l) == Some("user"))
            .cloned()
            .collect();
        let system: Vec<Value> = current
            .iter()
            .filter(|l| source(l) != Some("user"))
            .cloned()
            .collect();
        let same_set = system.len() == wanted.len()
            && wanted
                .iter()
                .all(|e| system.iter().any(|c| same_lock(c, e)));
        if same_set {
            continue;
        }
        let merged: Vec<Value> = wanted
            .iter()
            .map(|e| match system.iter().find(|c| same_lock(c, e)) {
                Some(existing) => {
                    let mut lock = e.clone();
                    lock["lockedAt"] = existing.get("lockedAt").cloned().unwrap_or(Value::Null);
                    lock
                }
                None => e.clone(),
            })
            .collect();
        let mut next = user;
        next.extend(merged);
        let metadata = with_locks(record.get("metadata"), next);
        dns_records::Entity::update_many()
            .set(dns_records::ActiveModel {
                metadata: Set(Some(metadata)),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .filter(dns_records::Column::Id.eq(text(record, "id")))
            .exec(&orm(db))
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_locks() {
        let metadata = json!({ "note": 1, "locks": [{ "source": "weldmail", "reason": "r" }, { "source": "user", "reason": "old" }] });
        let locked = add_user_lock(Some(&metadata), "mine");
        assert_eq!(locked["locks"].as_array().map(Vec::len), Some(2));
        assert_eq!(locked["locks"][1]["reason"], "mine");
        let unlocked = remove_user_lock(Some(&locked));
        assert_eq!(unlocked["locks"].as_array().map(Vec::len), Some(1));
        assert_eq!(remove_user_lock(None), json!({}));
        assert_eq!(lock_key(&json!("txt"), &json!("A.com.")), "TXT|a.com");
    }
}
