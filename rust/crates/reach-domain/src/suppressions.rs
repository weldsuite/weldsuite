//! `suppressions.ts`: addresses and whole domains WeldReach never emails.
//! A domain entry covers its subdomains too.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    reach_enrollments as enrollments, reach_prospects as prospects, reach_suppressions,
};

use crate::campaigns::complete_and_publish;
use crate::lists::{before, cursor_row, probe};
use crate::schemas::email_domain;
use crate::validation::is_valid_email_syntax;
use crate::{EventSink, ReachError, ReachResult, field, js_all, now};

/// `SuppressionHit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuppressionHit {
    pub value: String,
    pub kind: String,
    pub reason: String,
}

/// `domainSuffixes(domain)`: itself and every parent that still has a dot.
pub fn domain_suffixes(domain: &str) -> Vec<String> {
    let lower = domain.to_lowercase();
    let labels: Vec<&str> = lower.split('.').filter(|l| !l.is_empty()).collect();
    (0..labels.len().saturating_sub(1))
        .map(|i| labels[i..].join("."))
        .collect()
}

/// `SuppressionIndex`: the rows that can apply to a batch of emails.
#[derive(Debug, Clone, Default)]
pub struct SuppressionIndex {
    emails: HashMap<String, SuppressionHit>,
    domains: HashMap<String, SuppressionHit>,
}

impl SuppressionIndex {
    /// The entry that suppresses this lower-cased address.
    pub fn check(&self, email: &str) -> Option<&SuppressionHit> {
        if let Some(hit) = self.emails.get(email) {
            return Some(hit);
        }
        domain_suffixes(&email_domain(email))
            .into_iter()
            .find_map(|suffix| self.domains.get(&suffix))
    }
}

/// The prospects an entry list matches (`prospectMatches`): the emails, the
/// domains, and the subdomain patterns. No entries match nothing.
fn prospect_match(emails: &[String], domains: &[String], patterns: &[String]) -> Condition {
    let mut matches = Condition::any();
    if !emails.is_empty() {
        matches = matches.add(prospects::Column::Email.is_in(emails));
    }
    if !domains.is_empty() {
        matches = matches.add(prospects::Column::CompanyDomain.is_in(domains));
    }
    for pattern in patterns {
        matches = matches.add(prospects::Column::CompanyDomain.like(pattern.as_str()));
    }
    matches
}

const LOOKUP_CHUNK: usize = 1000;

/// `loadSuppressionIndex(db, emails)`.
pub async fn load_index(db: &PgPool, emails: &[String]) -> ReachResult<SuppressionIndex> {
    let mut wanted: Vec<String> = Vec::new();
    for email in emails {
        if !wanted.contains(email) {
            wanted.push(email.clone());
        }
        for suffix in domain_suffixes(&email_domain(email)) {
            if !wanted.contains(&suffix) {
                wanted.push(suffix);
            }
        }
    }
    let mut index = SuppressionIndex::default();
    let conn = orm(db);
    for chunk in wanted.chunks(LOOKUP_CHUNK) {
        let rows: Vec<(String, String, String)> = reach_suppressions::Entity::find()
            .select_only()
            .column(reach_suppressions::Column::Value)
            .column(reach_suppressions::Column::Type)
            .column(reach_suppressions::Column::Reason)
            .filter(reach_suppressions::Column::Value.is_in(chunk))
            .into_tuple()
            .all(&conn)
            .await?;
        for (value, kind, reason) in rows {
            let hit = SuppressionHit {
                value: value.clone(),
                kind: kind.clone(),
                reason,
            };
            if kind == "domain" {
                index.domains.insert(value, hit);
            } else {
                index.emails.insert(value, hit);
            }
        }
    }
    Ok(index)
}

static DOMAIN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
        .expect("domain")
});

/// `normalizeSuppressionValue(raw)`: `(value, type)`.
pub fn normalize_value(raw: &str) -> Option<(String, &'static str)> {
    let value = crate::text::js_trim(raw).to_lowercase();
    if value.is_empty() {
        return None;
    }
    if let Some(domain) = value.strip_prefix('@') {
        return DOMAIN_RE
            .is_match(domain)
            .then(|| (domain.to_owned(), "domain"));
    }
    if value.contains('@') {
        return is_valid_email_syntax(&value).then_some((value, "email"));
    }
    DOMAIN_RE.is_match(&value).then_some((value, "domain"))
}

/// `addSuppressions(db, values, options)`: (added entries, skipped count).
pub async fn add_suppressions(
    db: &PgPool,
    raw_values: &[String],
    reason: &str,
    source: Option<&str>,
    created_by: Option<&str>,
) -> ReachResult<(Vec<(String, String)>, usize)> {
    let mut unique: Vec<(String, &'static str)> = Vec::new();
    for raw in raw_values {
        if let Some((value, kind)) = normalize_value(raw) {
            match unique.iter_mut().find(|(v, _)| *v == value) {
                Some(entry) => entry.1 = kind,
                None => unique.push((value, kind)),
            }
        }
    }
    let mut added: Vec<(String, String)> = Vec::new();
    let conn = orm(db);
    for chunk in unique.chunks(500) {
        let rows = reach_suppressions::Entity::insert_many(chunk.iter().map(|(value, kind)| {
            reach_suppressions::ActiveModel {
                id: Set(generate_id("rsup")),
                value: Set(value.clone()),
                type_: Set((*kind).to_owned()),
                reason: Set(reason.to_owned()),
                source: Set(source.map(str::to_owned)),
                created_by: Set(created_by.map(str::to_owned)),
                ..Default::default()
            }
        }))
        .on_conflict(on_value_do_nothing())
        .exec_with_returning(&conn)
        .await?;
        added.extend(rows.into_iter().map(|row| (row.value, row.type_)));
    }
    let skipped = raw_values.len() - added.len();
    Ok((added, skipped))
}

/// `onConflictDoNothing({ target: value })`.
fn on_value_do_nothing() -> OnConflict {
    OnConflict::column(reach_suppressions::Column::Value)
        .do_nothing()
        .to_owned()
}

/// `toSuppressionDto(row)`.
pub fn to_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "value": field(row, "value"),
        "type": field(row, "type"),
        "reason": field(row, "reason"),
        "source": field(row, "source"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
    })
}

/// The `like` pattern `%.<domain>` with the wildcards escaped.
fn subdomain_pattern(domain: &str) -> String {
    let mut out = String::from("%.");
    for c in domain.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `applySuppressionsToProspects(db, entries, reason)`: the campaigns that
/// lost an enrollment.
pub async fn apply_to_prospects(
    db: &PgPool,
    entries: &[(String, String)],
    reason: &str,
) -> ReachResult<Vec<String>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let emails: Vec<String> = entries
        .iter()
        .filter(|(_, k)| k == "email")
        .map(|(v, _)| v.clone())
        .collect();
    let domains: Vec<String> = entries
        .iter()
        .filter(|(_, k)| k == "domain")
        .map(|(v, _)| v.clone())
        .collect();
    let patterns: Vec<String> = domains.iter().map(|d| subdomain_pattern(d)).collect();
    let at = now();
    let conn = orm(db);
    prospects::Entity::update_many()
        .col_expr(prospects::Column::Validation, Expr::value("suppressed"))
        .col_expr(prospects::Column::UpdatedAt, Expr::value(at))
        .filter(prospect_match(&emails, &domains, &patterns))
        .filter(prospects::Column::Validation.eq("valid"))
        .filter(prospects::Column::DeletedAt.is_null())
        .exec(&conn)
        .await?;
    let ids: Vec<String> = prospects::Entity::find()
        .select_only()
        .column(prospects::Column::Id)
        .filter(prospect_match(&emails, &domains, &patterns))
        .filter(prospects::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&conn)
        .await?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut campaigns: Vec<String> = Vec::new();
    let stopped_reason = format!("suppressed:{reason}");
    let never: Option<OffsetDateTime> = None;
    for chunk in ids.chunks(LOOKUP_CHUNK) {
        let rows = enrollments::Entity::update_many()
            .col_expr(enrollments::Column::Status, Expr::value("unsubscribed"))
            .col_expr(
                enrollments::Column::StoppedReason,
                Expr::value(stopped_reason.as_str()),
            )
            .col_expr(enrollments::Column::ClaimedAt, Expr::value(never))
            .col_expr(enrollments::Column::NextSendAt, Expr::value(never))
            .col_expr(enrollments::Column::UpdatedAt, Expr::value(at))
            .filter(enrollments::Column::ProspectId.is_in(chunk))
            .filter(enrollments::Column::Status.is_in(["queued", "active"]))
            .exec_with_returning(&conn)
            .await?;
        campaigns.extend(rows.into_iter().map(|row| row.campaign_id));
    }
    Ok(crate::unique(&campaigns))
}

/// `releaseSuppressedProspects(db, entry)`.
pub async fn release_prospects(db: &PgPool, value: &str, kind: &str) -> ReachResult<()> {
    let (emails, domains): (Vec<String>, Vec<String>) = if kind == "domain" {
        (Vec::new(), vec![value.to_owned()])
    } else {
        (vec![value.to_owned()], Vec::new())
    };
    let patterns: Vec<String> = domains.iter().map(|d| subdomain_pattern(d)).collect();
    let conn = orm(db);
    let candidates: Vec<(String, String)> = prospects::Entity::find()
        .select_only()
        .column(prospects::Column::Id)
        .column(prospects::Column::Email)
        .filter(prospect_match(&emails, &domains, &patterns))
        .filter(prospects::Column::Validation.eq("suppressed"))
        .into_tuple()
        .all(&conn)
        .await?;
    if candidates.is_empty() {
        return Ok(());
    }
    let index = load_index(
        db,
        &candidates
            .iter()
            .map(|(_, e)| e.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    let free: Vec<String> = candidates
        .into_iter()
        .filter(|(_, email)| index.check(email).is_none())
        .map(|(id, _)| id)
        .collect();
    for chunk in free.chunks(LOOKUP_CHUNK) {
        prospects::Entity::update_many()
            .col_expr(prospects::Column::Validation, Expr::value("valid"))
            .col_expr(prospects::Column::UpdatedAt, Expr::value(now()))
            .filter(prospects::Column::Id.is_in(chunk))
            .exec(&conn)
            .await?;
    }
    Ok(())
}

/// `listSuppressions(db, q)`.
pub async fn list(db: &PgPool, query: &crate::lists::PageQuery) -> ReachResult<crate::lists::Page> {
    use reach_suppressions::Column;
    let limit = crate::lists::parse_limit(query.limit.as_deref());
    let search = query
        .search
        .as_deref()
        .map(crate::text::js_trim)
        .filter(|s| !s.is_empty())
        .map(|_| crate::lists::like_pattern(query.search.as_deref().unwrap_or_default()));
    let cursor = cursor_row::<reach_suppressions::Entity>(
        db,
        Column::CreatedAt,
        Column::Id,
        query.cursor.as_deref(),
    )
    .await?;
    let mut filters = Condition::all();
    if let Some(search) = &search {
        filters = filters.add(Column::Value.ilike(search.as_str()));
    }
    let page = match &cursor {
        Some(cursor) => filters
            .clone()
            .add(before(Column::CreatedAt, Column::Id, cursor)),
        None => filters.clone(),
    };
    let conn = orm(db);
    let rows = reach_suppressions::Entity::find()
        .filter(page)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe(limit))
        .all(&conn)
        .await?;
    let total = reach_suppressions::Entity::find()
        .filter(filters)
        .count(&conn)
        .await?;
    Ok(crate::lists::page_result(
        &js_all(rows.into_iter().map(serde_json::to_value))?,
        limit,
        i64::try_from(total).unwrap_or(i64::MAX),
        to_dto,
    ))
}

/// `addManualSuppressions(deps, values)`: `(added, skipped)`.
pub async fn add_manual(
    db: &PgPool,
    emit: &dyn EventSink,
    values: &[String],
    user_id: &str,
) -> ReachResult<(usize, usize)> {
    let (entries, skipped) =
        add_suppressions(db, values, "manual", Some("manual"), Some(user_id)).await?;
    let campaigns = apply_to_prospects(db, &entries, "manual").await?;
    complete_and_publish(db, emit, &campaigns).await?;
    Ok((entries.len(), skipped))
}

/// `removeSuppression(db, id)`.
pub async fn remove(db: &PgPool, id: &str) -> ReachResult<()> {
    let row = reach_suppressions::Entity::delete_many()
        .filter(reach_suppressions::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(|row| (row.value, row.type_));
    let Some((value, kind)) = row else {
        return Err(ReachError::not_found("Suppression", Some(id)));
    };
    release_prospects(db, &value, &kind).await
}

/// `suppressEmail(db, email, reason, source, createdBy)`: idempotent.
pub async fn suppress_email(
    db: &PgPool,
    email: &str,
    reason: &str,
    source: Option<&str>,
    created_by: Option<&str>,
) -> ReachResult<()> {
    reach_suppressions::Entity::insert(reach_suppressions::ActiveModel {
        id: Set(generate_id("rsup")),
        value: Set(email.to_lowercase()),
        type_: Set("email".to_owned()),
        reason: Set(reason.to_owned()),
        source: Set(source.map(str::to_owned)),
        created_by: Set(created_by.map(str::to_owned)),
        ..Default::default()
    })
    .on_conflict(on_value_do_nothing())
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_and_suffixes() {
        assert_eq!(
            domain_suffixes("a.b.example.com"),
            vec!["a.b.example.com", "b.example.com", "example.com"]
        );
        assert_eq!(
            normalize_value(" @Example.com "),
            Some(("example.com".to_owned(), "domain"))
        );
        assert_eq!(
            normalize_value("ann@acme.com"),
            Some(("ann@acme.com".to_owned(), "email"))
        );
        assert_eq!(normalize_value("not a value"), None);
        assert_eq!(subdomain_pattern("a_b.com"), "%.a\\_b.com");
    }
}
