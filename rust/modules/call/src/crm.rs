//! CRM lookups by phone, name or email (`services/desk-phone-crm.ts`): who
//! is calling, what the voice agent's `lookup_crm` tool answers, and the
//! per-person call statistics of the WeldCall People grid
//! (`services/contact-call-stats.ts`).

use serde_json::{Value, json};
use weldsuite_db::PgPool;

use crate::registry::normalize_e164;

/// `CrmLookupHit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    pub(crate) kind: &'static str,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) email: Option<String>,
    pub(crate) phone: Option<String>,
    pub(crate) company_name: Option<String>,
}

/// `digitsOnly(phone)`.
fn digits_only(phone: &str) -> String {
    phone.chars().filter(char::is_ascii_digit).collect()
}

/// `phoneLookupSuffix(phone)`: the last eight digits, when there are eight.
pub(crate) fn lookup_suffix(phone: &str) -> Option<String> {
    let digits = digits_only(phone);
    (digits.len() >= 8).then(|| digits[digits.len() - 8..].to_owned())
}

/// `comparableDigits(phone)`: digits without a `00` or `0` prefix.
fn comparable(phone: &str) -> String {
    let mut digits = digits_only(phone);
    if let Some(rest) = digits.strip_prefix("00") {
        digits = rest.to_owned();
    }
    if let Some(rest) = digits.strip_prefix('0') {
        digits = rest.to_owned();
    }
    digits
}

/// `phonesMatch(a, b)`.
pub(crate) fn phones_match(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if normalize_e164(a) == normalize_e164(b) {
        return true;
    }
    let (ca, cb) = (comparable(a), comparable(b));
    if ca.is_empty() || cb.is_empty() {
        return false;
    }
    if ca == cb || ca.ends_with(&cb) || cb.ends_with(&ca) {
        return true;
    }
    if ca.len() < 8 || cb.len() < 8 {
        return false;
    }
    ca[ca.len() - 8..] == cb[cb.len() - 8..]
}

/// `a || b` over optional strings.
fn either(a: Option<String>, b: Option<String>) -> Option<String> {
    a.filter(|s| !s.is_empty()).or(b)
}

/// `hitName(parts, fallback)`.
fn hit_name(parts: &[Option<String>], fallback: &str) -> String {
    let joined = parts
        .iter()
        .flatten()
        .map(|part| weldsuite_kit::validation::js_trim(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let joined = weldsuite_kit::validation::js_trim(&joined);
    if joined.is_empty() {
        fallback.to_owned()
    } else {
        joined.to_owned()
    }
}

type PersonRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type CompanyRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type LeadRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

/// `lookupCrm(db, query, limit)`: people, then companies, then leads, at
/// most `limit` in all. A query of eight digits or more matches phone
/// numbers by their last eight digits; anything else names and emails.
pub(crate) async fn lookup(db: &PgPool, query: &str, limit: i64) -> Result<Vec<Hit>, sqlx::Error> {
    let q = weldsuite_kit::validation::js_trim(query);
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let suffix = (digits_only(q).len() >= 8)
        .then(|| lookup_suffix(q))
        .flatten();
    let by_phone = suffix.is_some();
    let pattern = suffix.map_or_else(|| format!("%{}%", q.to_lowercase()), |s| format!("%{s}"));
    let mut hits = Vec::new();

    let people: Vec<PersonRow> = sqlx::query_as(
        "select id, display_name, email, direct_phone, mobile_phone from people
         where deleted_at is null and (case when $1 then
             regexp_replace(coalesce(direct_phone, ''), '[^0-9]', '', 'g') like $2
             or regexp_replace(coalesce(mobile_phone, ''), '[^0-9]', '', 'g') like $2
         else
             lower(display_name) like $2 or lower(coalesce(email, '')) like $2
             or first_name ilike $2 or last_name ilike $2
         end) limit $3",
    )
    .bind(by_phone)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(db)
    .await?;
    for (id, display_name, email, direct, mobile) in people {
        hits.push(Hit {
            kind: "contact",
            id,
            name: display_name,
            email,
            phone: either(mobile, direct),
            company_name: None,
        });
    }

    let companies: Vec<CompanyRow> = sqlx::query_as(
        "select id, display_name, name, email, phone, mobile from companies
         where deleted_at is null and (case when $1 then
             regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') like $2
             or regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g') like $2
         else
             lower(display_name) like $2 or lower(coalesce(name, '')) like $2
             or lower(coalesce(email, '')) like $2
         end) limit $3",
    )
    .bind(by_phone)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(db)
    .await?;
    for (id, display_name, name, email, phone, mobile) in companies {
        let label = either(Some(display_name), Some(name)).unwrap_or_default();
        hits.push(Hit {
            kind: "customer",
            id,
            name: label.clone(),
            email,
            phone: either(phone, mobile),
            company_name: Some(label),
        });
    }

    let leads: Vec<LeadRow> = sqlx::query_as(
        "select id, first_name, last_name, full_name, company_name, email, phone, mobile
         from crm_leads
         where deleted_at is null and (case when $1 then
             regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') like $2
             or regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g') like $2
         else
             lower(coalesce(full_name, '')) like $2 or lower(coalesce(company_name, '')) like $2
             or lower(email) like $2 or first_name ilike $2 or last_name ilike $2
         end) limit $3",
    )
    .bind(by_phone)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(db)
    .await?;
    for (id, first, last, full, company, email, phone, mobile) in leads {
        hits.push(Hit {
            kind: "lead",
            id,
            name: hit_name(&[full, first, last], &email),
            email: Some(email),
            phone: either(phone, mobile),
            company_name: company,
        });
    }
    hits.truncate(usize::try_from(limit).unwrap_or(0));
    Ok(hits)
}

/// `CallerMatch`.
#[derive(Debug, Clone, Default)]
#[allow(clippy::struct_field_names)] // the TypeScript names
pub(crate) struct Caller {
    pub(crate) contact_id: Option<String>,
    pub(crate) customer_id: Option<String>,
    pub(crate) caller_name: Option<String>,
    pub(crate) customer_name: Option<String>,
    pub(crate) email: Option<String>,
}

/// `matchCallerByPhone(db, fromNumber)`.
pub(crate) async fn match_caller(db: &PgPool, from_number: &str) -> Result<Caller, sqlx::Error> {
    let hits = lookup(db, from_number, 5).await?;
    let find = |kind: &str| hits.iter().find(|hit| hit.kind == kind);
    let (contact, customer, lead) = (find("contact"), find("customer"), find("lead"));
    Ok(Caller {
        contact_id: contact.map(|h| h.id.clone()),
        customer_id: customer.map(|h| h.id.clone()),
        caller_name: contact.or(lead).or(customer).map(|h| h.name.clone()),
        customer_name: customer
            .map(|h| Some(h.name.clone()))
            .or_else(|| lead.map(|h| h.company_name.clone()))
            .flatten(),
        email: contact
            .map(|h| h.email.clone())
            .filter(Option::is_some)
            .or_else(|| customer.map(|h| h.email.clone()).filter(Option::is_some))
            .or_else(|| lead.map(|h| h.email.clone()))
            .flatten(),
    })
}

/// `formatCrmLookupForAssistant(hits)`.
pub(crate) fn for_assistant(hits: &[Hit]) -> Value {
    if hits.is_empty() {
        return json!({ "matched": 0, "results": [], "message": "No matching CRM records." });
    }
    let results: Vec<Value> = hits
        .iter()
        .map(|h| {
            json!({
                "type": h.kind,
                "id": h.id,
                "name": h.name,
                "email": h.email,
                "phone": h.phone,
                "company": h.company_name,
            })
        })
        .collect();
    json!({ "matched": hits.len(), "results": results })
}

// ── per-person call statistics ───────────────────────────────────────────────

/// One call as the statistics read it: `(contactId, direction, fromNumber,
/// toNumber, duration, initiatedAt)`.
type StatsCall = (Option<String>, String, String, String, Option<i32>, String);

/// `getContactCallStats(db, contactIds, scopeUserId)`: a call counts for a
/// person when it is linked to them, or, unlinked, when the other party's
/// number matches one of theirs. Unknown people count zero.
pub(crate) async fn contact_call_stats(
    db: &PgPool,
    contact_ids: &[String],
    scope_user_id: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    if contact_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, direct_phone, mobile_phone from people
         where id = any($1) and deleted_at is null",
    )
    .bind(contact_ids)
    .fetch_all(db)
    .await?;
    let phones_of = |id: &str| -> Vec<String> {
        rows.iter()
            .find(|(row_id, _, _)| row_id == id)
            .map(|(_, direct, mobile)| {
                [direct, mobile]
                    .into_iter()
                    .flatten()
                    .map(|p| weldsuite_kit::validation::js_trim(p).to_owned())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let people: Vec<(String, Vec<String>)> = contact_ids
        .iter()
        .map(|id| (id.clone(), phones_of(id)))
        .collect();
    let mut suffixes: Vec<String> = Vec::new();
    for (_, phones) in &people {
        for phone in phones {
            if let Some(suffix) = lookup_suffix(phone)
                && !suffixes.contains(&suffix)
            {
                suffixes.push(suffix);
            }
        }
    }
    let patterns: Vec<String> = suffixes.iter().map(|s| format!("%{s}")).collect();
    let calls: Vec<StatsCall> = sqlx::query_as(
        "select contact_id, direction, from_number, to_number, duration,
             to_char(initiated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         from voip_calls
         where (contact_id = any($1) or (cardinality($2::text[]) > 0 and contact_id is null
             and regexp_replace(case when direction = 'outbound' then to_number else from_number end,
                 '[^0-9]', '', 'g') like any($2::text[])))
           and ($3::text is null or user_id = $3)",
    )
    .bind(contact_ids)
    .bind(&patterns)
    .bind(scope_user_id)
    .fetch_all(db)
    .await?;
    Ok(people
        .iter()
        .map(|(id, phones)| aggregate(id, phones, &calls))
        .collect())
}

/// One person's statistics (`aggregateContactCallStats`).
fn aggregate(id: &str, phones: &[String], calls: &[StatsCall]) -> Value {
    let (mut total, mut inbound, mut outbound, mut duration) = (0_i64, 0_i64, 0_i64, 0_i64);
    let mut last: Option<&str> = None;
    for (contact_id, direction, from, to, secs, initiated) in calls {
        let remote = if direction == "outbound" { to } else { from };
        let belongs = contact_id.as_ref().map_or_else(
            || phones.iter().any(|phone| phones_match(remote, phone)),
            |linked| linked == id,
        );
        if !belongs {
            continue;
        }
        total += 1;
        if direction == "inbound" {
            inbound += 1;
        }
        if direction == "outbound" {
            outbound += 1;
        }
        duration += i64::from(secs.unwrap_or(0));
        if last.is_none_or(|l| initiated.as_str() > l) {
            last = Some(initiated);
        }
    }
    json!({
        "contactId": id,
        "totalCalls": total,
        "inboundCalls": inbound,
        "outboundCalls": outbound,
        "totalDuration": duration,
        "lastCallAt": last,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_match_like_the_worker() {
        assert!(phones_match("+31 6 55443322", "06 55 44 33 22"));
        assert!(phones_match("0032475123456", "+32475123456"));
        assert!(!phones_match("+31201112222", "+31655443322"));
        assert!(!phones_match("", "+31"));
        assert_eq!(
            lookup_suffix("+31 6 5544 3322").as_deref(),
            Some("55443322")
        );
        assert_eq!(lookup_suffix("12345"), None);
        assert_eq!(
            hit_name(
                &[None, Some(" Ann ".to_owned()), Some("Lee".to_owned())],
                "x@y"
            ),
            "Ann Lee"
        );
        assert_eq!(hit_name(&[None, None, None], "x@y"), "x@y");
    }
}
