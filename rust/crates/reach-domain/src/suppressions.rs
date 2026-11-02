//! `suppressions.ts`: addresses and whole domains WeldReach never emails.
//! A domain entry covers its subdomains too.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::campaigns::complete_and_publish;
use crate::schemas::email_domain;
use crate::validation::is_valid_email_syntax;
use crate::{EventSink, ReachError, ReachResult, field, iso, js_rows, now};

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

/// The prospects an entry list matches: $1 emails, $2 domains, $3 the
/// subdomain patterns (`prospectMatches`).
macro_rules! prospect_match {
    () => {
        "((cardinality($1::varchar[]) > 0 and email = any($1)) or (cardinality($2::varchar[]) > 0 and company_domain = any($2)) or company_domain like any($3::text[]))"
    };
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
    for chunk in wanted.chunks(LOOKUP_CHUNK) {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "select value, type, reason from reach_suppressions where value = any($1)",
        )
        .bind(chunk)
        .fetch_all(db)
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
    for chunk in unique.chunks(500) {
        let ids: Vec<String> = chunk.iter().map(|_| generate_id("rsup")).collect();
        let values: Vec<String> = chunk.iter().map(|(v, _)| v.clone()).collect();
        let kinds: Vec<String> = chunk.iter().map(|(_, k)| (*k).to_owned()).collect();
        let rows: Vec<(String, String)> = sqlx::query_as(
            "insert into reach_suppressions (id, value, type, reason, source, created_by)
             select id, value, kind, $4, $5, $6 from unnest($1::varchar[], $2::varchar[], $3::varchar[]) as v(id, value, kind)
             on conflict (value) do nothing
             returning value, type",
        )
        .bind(&ids)
        .bind(&values)
        .bind(&kinds)
        .bind(reason)
        .bind(source)
        .bind(created_by)
        .fetch_all(db)
        .await?;
        added.extend(rows);
    }
    let skipped = raw_values.len() - added.len();
    Ok((added, skipped))
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
    let at = iso(now());
    sqlx::query(concat!(
        "update reach_prospects set validation = 'suppressed', updated_at = $4::timestamptz where ",
        prospect_match!(),
        " and validation = 'valid' and deleted_at is null"
    ))
    .bind(&emails)
    .bind(&domains)
    .bind(&patterns)
    .bind(&at)
    .execute(db)
    .await?;
    let ids: Vec<String> = sqlx::query_scalar(concat!(
        "select id from reach_prospects where ",
        prospect_match!(),
        " and deleted_at is null"
    ))
    .bind(&emails)
    .bind(&domains)
    .bind(&patterns)
    .fetch_all(db)
    .await?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut campaigns: Vec<String> = Vec::new();
    let stopped_reason = format!("suppressed:{reason}");
    for chunk in ids.chunks(LOOKUP_CHUNK) {
        let rows: Vec<String> = sqlx::query_scalar(
            "update reach_enrollments set status = 'unsubscribed', stopped_reason = $2, claimed_at = null,
                 next_send_at = null, updated_at = $3::timestamptz
             where prospect_id = any($1) and status in ('queued', 'active')
             returning campaign_id",
        )
        .bind(chunk)
        .bind(&stopped_reason)
        .bind(&at)
        .fetch_all(db)
        .await?;
        campaigns.extend(rows);
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
    let candidates: Vec<(String, String)> = sqlx::query_as(
        "select id, email from reach_prospects
         where ((cardinality($1::varchar[]) > 0 and email = any($1))
             or (cardinality($2::varchar[]) > 0 and company_domain = any($2))
             or company_domain like any($3::text[]))
           and validation = 'suppressed'",
    )
    .bind(&emails)
    .bind(&domains)
    .bind(&patterns)
    .fetch_all(db)
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
        sqlx::query("update reach_prospects set validation = 'valid', updated_at = $2::timestamptz where id = any($1)")
            .bind(chunk)
            .bind(iso(now()))
            .execute(db)
            .await?;
    }
    Ok(())
}

/// `listSuppressions(db, q)`.
pub async fn list(db: &PgPool, query: &crate::lists::PageQuery) -> ReachResult<crate::lists::Page> {
    let limit = crate::lists::parse_limit(query.limit.as_deref());
    let search = query
        .search
        .as_deref()
        .map(crate::text::js_trim)
        .filter(|s| !s.is_empty())
        .map(|_| crate::lists::like_pattern(query.search.as_deref().unwrap_or_default()));
    let cursor =
        crate::lists::cursor_row(db, "reach_suppressions", query.cursor.as_deref()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_suppressions t
         where ($1::text is null or t.value ilike $1)
           and ($2::timestamptz is null or t.created_at < $2::timestamptz or (t.created_at = $2::timestamptz and t.id < $3))
         order by t.created_at desc, t.id desc limit $4",
    )
    .bind(&search)
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from reach_suppressions t where ($1::text is null or t.value ilike $1)",
    )
    .bind(&search)
    .fetch_one(db)
    .await?;
    Ok(crate::lists::page_result(
        &js_rows(rows),
        limit,
        total,
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
    let row: Option<(String, String)> =
        sqlx::query_as("delete from reach_suppressions where id = $1 returning value, type")
            .bind(id)
            .fetch_optional(db)
            .await?;
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
    sqlx::query(
        "insert into reach_suppressions (id, value, type, reason, source, created_by)
         values ($1, $2, 'email', $3, $4, $5) on conflict (value) do nothing",
    )
    .bind(generate_id("rsup"))
    .bind(email.to_lowercase())
    .bind(reason)
    .bind(source)
    .bind(created_by)
    .execute(db)
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
