//! Member and status checks the company and person writes share
//! (`member-validation.ts`, `status-validation.ts`).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use weldsuite_db::PgPool;

use crate::{DomainError, DomainResult};

/// `BUILTIN_CUSTOMER_STATUSES`.
pub const BUILTIN_CUSTOMER_STATUSES: [&str; 5] =
    ["prospect", "active", "inactive", "churned", "blacklisted"];

/// `assertValidMemberFields(db, input)`: `ownerId` and `accountManagerId`,
/// when set, must name live workspace members.
pub async fn assert_valid_member_fields(
    db: &PgPool,
    input: &Map<String, Value>,
) -> DomainResult<()> {
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
    };
    let mut ids: Vec<String> = Vec::new();
    for key in ["ownerId", "accountManagerId"] {
        if let Some(id) = text(key)
            && !ids.iter().any(|known| known == id)
        {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    let valid: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = any($1) and deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let valid: HashSet<String> = valid.into_iter().collect();
    for key in ["ownerId", "accountManagerId"] {
        if let Some(id) = text(key)
            && !valid.contains(id)
        {
            return Err(DomainError::InvalidMemberId {
                message: format!("\"{id}\" is not a member of this workspace"),
                field: key.to_owned(),
            });
        }
    }
    Ok(())
}

/// `CustomerStatusLookup`: the configured status keys, and a forgiving
/// lowercase slug or name → key map for imports.
#[derive(Debug, Clone, Default)]
pub struct StatusLookup {
    pub keys: HashSet<String>,
    pub by_loose_name: HashMap<String, String>,
}

/// `loadCustomerStatusLookup(db)`.
pub async fn load_status_lookup(db: &PgPool) -> DomainResult<StatusLookup> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("select slug, name from crm_customer_statuses where deleted_at is null")
            .fetch_all(db)
            .await?;
    let mut lookup = StatusLookup::default();
    for key in BUILTIN_CUSTOMER_STATUSES {
        lookup.keys.insert(key.to_owned());
        lookup.by_loose_name.insert(key.to_owned(), key.to_owned());
    }
    for (slug, name) in rows {
        lookup.keys.insert(slug.clone());
        lookup
            .by_loose_name
            .insert(slug.to_lowercase(), slug.clone());
        let name = weldsuite_kit::validation::js_trim(&name).to_lowercase();
        if !name.is_empty() && !lookup.by_loose_name.contains_key(&name) {
            lookup.by_loose_name.insert(name, slug);
        }
    }
    Ok(lookup)
}

/// `assertValidCustomerStatus(db, status, lookup)`.
pub async fn assert_valid_status(
    db: &PgPool,
    status: Option<&Value>,
    lookup: Option<&StatusLookup>,
) -> DomainResult<()> {
    let Some(Value::String(status)) = status else {
        return Ok(());
    };
    let loaded;
    let lookup = if let Some(lookup) = lookup {
        lookup
    } else {
        loaded = load_status_lookup(db).await?;
        &loaded
    };
    if lookup.keys.contains(status) {
        Ok(())
    } else {
        Err(DomainError::InvalidStatus {
            message: format!("\"{status}\" is not a configured customer status"),
            field: "status".to_owned(),
        })
    }
}

/// `containsPattern(term)`: `%term%` with `\`, `%` and `_` escaped.
pub fn contains_pattern(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// A decoded list cursor (`decodeListCursor`): the position, and the first
/// page's total when the cursor carries one.
#[derive(Debug, Clone)]
pub struct ListCursor {
    pub position: String,
    pub total_count: Option<i64>,
}

/// `decodeListCursor(cursor)`.
pub fn decode_list_cursor(cursor: Option<&str>) -> Option<ListCursor> {
    let cursor = cursor.filter(|c| !c.is_empty())?;
    let Some(at) = cursor.rfind('~') else {
        return Some(ListCursor {
            position: cursor.to_owned(),
            total_count: None,
        });
    };
    let total = weldsuite_kit::validation::js_number(&cursor[at + 1..]);
    #[allow(clippy::cast_possible_truncation)]
    let total_count = (total.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&total))
        .then_some(total as i64);
    Some(ListCursor {
        position: cursor[..at].to_owned(),
        total_count,
    })
}

/// `encodeListCursor(position, totalCount)`.
pub fn encode_list_cursor(position: &str, total_count: i64) -> String {
    format!("{position}~{total_count}")
}

/// `computeChanges(old, new, ['updatedAt', 'version'])`: the fields whose
/// JSON differs, as `{ old, new }`; `None` when nothing changed.
pub fn compute_changes(old: &Value, new: &Value) -> Option<Map<String, Value>> {
    let Value::Object(new) = new else {
        return None;
    };
    let mut changes = Map::new();
    for (key, value) in new {
        if key == "updatedAt" || key == "version" {
            continue;
        }
        let before = old.get(key).cloned().unwrap_or(Value::Null);
        if before != *value {
            changes.insert(
                key.clone(),
                serde_json::json!({ "old": before, "new": value }),
            );
        }
    }
    (!changes.is_empty()).then_some(changes)
}
