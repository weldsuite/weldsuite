//! Member and status checks the company and person writes share
//! (`member-validation.ts`, `status-validation.ts`).

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Alias, Expr, Func, Order, Query};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{crm_customer_statuses, workspace_members};

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
    let valid: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.is_in(ids))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
    let rows: Vec<(String, String)> = crm_customer_statuses::Entity::find()
        .select_only()
        .columns([
            crm_customer_statuses::Column::Slug,
            crm_customer_statuses::Column::Name,
        ])
        .filter(crm_customer_statuses::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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

/// `(coalesce(a, '') || E'\n' || coalesce(b, '') || …) ilike pattern`: the
/// search of a list over several text columns, one line each.
pub(crate) fn search_match<C: ColumnTrait>(columns: &[C], pattern: &str) -> Expr {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let line = |column: &C| Expr::expr(Func::coalesce([column.into_expr(), Expr::val("")]));
    let mut haystack: Option<Expr> = None;
    for column in columns {
        haystack = Some(match haystack {
            None => line(column),
            Some(text) => PgExpr::concat(PgExpr::concat(text, Expr::val("\n")), line(column)),
        });
    }
    PgExpr::ilike(haystack.unwrap_or_else(|| Expr::val("")), pattern)
}

/// A list's `sortDir`: the direction, `None` for a value that is neither
/// `asc` nor `desc` (the sort then doesn't apply).
pub(crate) fn sort_order(dir: &str) -> Option<Order> {
    match dir {
        "asc" => Some(Order::Asc),
        "desc" => Some(Order::Desc),
        _ => None,
    }
}

/// What a built-in sort orders by: `lower(col::text)` for the `text`
/// family, the column itself for the rest.
pub(crate) fn sort_value<C: ColumnTrait>(column: C, family: &str) -> Expr {
    use sea_orm::ExprTrait as _;
    if family == "text" {
        Expr::expr(Func::lower(column.into_expr().cast_as("text")))
    } else {
        column.into_expr()
    }
}

/// `(created_at, id) < (select created_at, id from <table> where id =
/// cursor)`: past the cursor row, newest first; nothing when that row is
/// gone.
pub(crate) fn before_row<E: EntityTrait>(
    created_at: E::Column,
    id: E::Column,
    cursor: &str,
) -> Expr {
    use sea_orm::ExprTrait as _;
    let row = Alias::new("c");
    let cursor_row = Query::select()
        .column((row.clone(), created_at))
        .column((row.clone(), id))
        .from_as(E::default(), row.clone())
        .and_where(Expr::col((row, id)).eq(cursor))
        .to_owned();
    Expr::tuple([created_at.into_expr(), id.into_expr()]).lt(Expr::from(cursor_row))
}

/// `limit $n` of a page with its probe row (`limit + 1`); Postgres refuses
/// a negative `LIMIT`.
pub(crate) fn probe_limit(limit: i64) -> Result<u64, DbErr> {
    u64::try_from(limit.saturating_add(1))
        .map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))
}

/// `count(*)` as Postgres returns it (a `bigint`).
pub(crate) fn count(rows: u64) -> i64 {
    i64::try_from(rows).unwrap_or(i64::MAX)
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
