//! Purchase order numbers for the purchase orders WeldStash creates itself
//! (draft POs from reorder suggestions): `PO-YYYYMMDD-XXXX`, the UTC date
//! and four characters from an alphabet without look-alikes (no `0`/`O`,
//! `1`/`I`). `po_number` has no unique index, so uniqueness is checked
//! against every purchase order of the workspace, deleted ones included.
//!
//! Twelve spare candidates go to the database in one query and the first
//! free ones win, so a collision costs nothing; 32⁴ (about a million)
//! numbers a day leave the spares all but unused. Should all of them be
//! taken, the number gets an eight-character suffix instead.

use std::collections::HashSet;

use sqlx::PgExecutor;
use time::{Date, OffsetDateTime};
use weldsuite_kit::random_string;

const ALPHABET: &str = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Spare candidates sent along with the ones asked for.
const SPARES: usize = 12;

/// `PO-YYYYMMDD-` for `date`.
pub(crate) fn po_number_prefix(date: Date) -> String {
    format!(
        "PO-{:04}{:02}{:02}-",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// One new purchase order number, not used by any purchase order of the
/// workspace. Runs on a pool, a connection or inside a transaction.
#[allow(dead_code)] // the replenishment routes number several orders at once
pub(crate) async fn generate_po_number<'e>(db: impl PgExecutor<'e>) -> Result<String, sqlx::Error> {
    let mut numbers = generate_po_numbers(db, 1).await?;
    Ok(numbers.pop().unwrap_or_else(|| fallback(&today_prefix())))
}

/// `count` distinct new purchase order numbers, for a request that creates
/// several purchase orders before inserting any (one query).
pub(crate) async fn generate_po_numbers<'e>(
    db: impl PgExecutor<'e>,
    count: usize,
) -> Result<Vec<String>, sqlx::Error> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let prefix = today_prefix();
    let candidates = candidates(&prefix, count + SPARES);
    let free: Vec<String> = sqlx::query_scalar(
        "select u.c from unnest($1::text[]) with ordinality as u(c, n) \
         where not exists (select 1 from purchase_orders p where p.po_number = u.c) \
         order by u.n limit $2",
    )
    .bind(&candidates)
    .bind(i64::try_from(count).unwrap_or(i64::MAX))
    .fetch_all(db)
    .await?;
    let mut numbers = free;
    while numbers.len() < count {
        numbers.push(fallback(&prefix));
    }
    Ok(numbers)
}

fn today_prefix() -> String {
    po_number_prefix(OffsetDateTime::now_utc().date())
}

/// `n` distinct candidates with `prefix`.
fn candidates(prefix: &str, n: usize) -> Vec<String> {
    let mut seen = HashSet::with_capacity(n);
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let candidate = format!("{prefix}{}", random_string(4, ALPHABET));
        if seen.insert(candidate.clone()) {
            out.push(candidate);
        }
    }
    out
}

/// The long form, when every short candidate was taken.
fn fallback(prefix: &str) -> String {
    format!("{prefix}{}", random_string(8, ALPHABET))
}

#[cfg(test)]
mod tests {
    use time::Month;

    use super::*;

    #[test]
    fn the_prefix_is_the_padded_date() {
        let date = Date::from_calendar_date(2026, Month::March, 4).expect("date");
        assert_eq!(po_number_prefix(date), "PO-20260304-");
    }

    #[test]
    fn candidates_are_distinct_and_well_formed() {
        let list = candidates("PO-20261118-", 40);
        assert_eq!(list.len(), 40);
        assert_eq!(list.iter().collect::<HashSet<_>>().len(), 40);
        for number in &list {
            let suffix = number.strip_prefix("PO-20261118-").expect("prefix");
            assert_eq!(suffix.len(), 4);
            assert!(suffix.chars().all(|c| ALPHABET.contains(c)), "{number}");
        }
        assert_eq!(fallback("PO-20261118-").len(), "PO-20261118-".len() + 8);
    }
}
