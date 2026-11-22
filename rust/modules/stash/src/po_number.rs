//! Purchase order numbers for the purchase orders WeldStash creates itself
//! (draft POs from reorder suggestions): `PO-YYYYMMDD-XXXX`, the UTC date
//! and four characters from an alphabet without look-alikes (no `0`/`O`,
//! `1`/`I`). `po_number` has no unique index, so uniqueness is checked
//! against every purchase order of the workspace, deleted ones included.
//!
//! Twelve spare candidates go to the database in one query (which of them
//! are taken) and the first free ones win, so a collision costs nothing;
//! 32⁴ (about a million)
//! numbers a day leave the spares all but unused. Should all of them be
//! taken, the number gets an eight-character suffix instead.

use std::collections::HashSet;

use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use time::{Date, OffsetDateTime};
use weldsuite_kit::random_string;
use weldsuite_schema::tenant::purchase_orders;

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
/// workspace. Runs on the pool (`orm`) or inside a transaction (`OrmConn`).
#[allow(dead_code)] // the replenishment routes number several orders at once
pub(crate) async fn generate_po_number<C: ConnectionTrait>(db: &C) -> Result<String, DbErr> {
    let mut numbers = generate_po_numbers(db, 1).await?;
    Ok(numbers.pop().unwrap_or_else(|| fallback(&today_prefix())))
}

/// `count` distinct new purchase order numbers, for a request that creates
/// several purchase orders before inserting any (one query).
pub(crate) async fn generate_po_numbers<C: ConnectionTrait>(
    db: &C,
    count: usize,
) -> Result<Vec<String>, DbErr> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let prefix = today_prefix();
    let candidates = candidates(&prefix, count + SPARES);
    let taken: HashSet<String> = purchase_orders::Entity::find()
        .select_only()
        .column(purchase_orders::Column::PoNumber)
        .filter(purchase_orders::Column::PoNumber.is_in(candidates.iter().map(String::as_str)))
        .into_tuple::<String>()
        .all(db)
        .await?
        .into_iter()
        .collect();
    let mut numbers = free(candidates, &taken, count);
    while numbers.len() < count {
        numbers.push(fallback(&prefix));
    }
    Ok(numbers)
}

/// The first `count` candidates no purchase order uses, in candidate order.
fn free(candidates: Vec<String>, taken: &HashSet<String>, count: usize) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|candidate| !taken.contains(candidate))
        .take(count)
        .collect()
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

    #[test]
    fn the_first_free_candidates_win() {
        let candidates: Vec<String> = ["a", "b", "c", "d"].map(str::to_owned).into();
        let taken: HashSet<String> = ["a", "c"].map(str::to_owned).into();
        assert_eq!(free(candidates.clone(), &taken, 1), vec!["b".to_owned()]);
        assert_eq!(free(candidates, &taken, 3), vec!["b".to_owned(), "d".to_owned()]);
    }
}
