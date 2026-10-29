//! Password health (`password-health.ts`): weak, reused and stale logins,
//! computed on demand by opening them in memory. No fingerprint of a
//! password is ever stored: an unsalted hash of a human-chosen password is
//! most of the way to the password. The report names items and verdicts.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::password_items::Item;
use crate::schemas::password_strength;

/// A password nobody changed in this long is worth a second look.
const OLD_PASSWORD_DAYS: i64 = 365;

/// `a.localeCompare(b)`: ICU's root collation, as Node's default locale
/// sorts (`en` and `nl` use the root order).
static COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
    CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default()).ok()
});

pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    COLLATOR
        .as_ref()
        .map_or_else(|| a.cmp(b), |collator| collator.compare(a, b))
}

/// `buildHealthReport(logins, now)`.
pub(crate) fn build_health_report(logins: Vec<(Item, String)>, now: OffsetDateTime) -> Value {
    let with_password: Vec<(Item, String)> = logins
        .into_iter()
        .filter(|(_, password)| !password.is_empty())
        .collect();
    let uses = |password: &str| {
        with_password
            .iter()
            .filter(|(_, other)| other == password)
            .count()
    };
    let stale_before = now - time::Duration::days(OLD_PASSWORD_DAYS);

    let (mut healthy, mut weak, mut reused, mut old) = (0, 0, 0, 0);
    let mut items: Vec<(usize, String, Value)> = Vec::new();
    for (item, password) in &with_password {
        let mut issues = Vec::new();
        let reuse_count = uses(password);
        if password_strength(password) == "weak" {
            issues.push("weak");
            weak += 1;
        }
        if reuse_count > 1 {
            issues.push("reused");
            reused += 1;
        }
        let stale = item
            .password_changed_at()
            .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
            .is_some_and(|at| at < stale_before);
        if stale {
            issues.push("old");
            old += 1;
        }
        if issues.is_empty() {
            healthy += 1;
            continue;
        }
        let mut entry = item.json.clone();
        entry["issues"] = json!(issues);
        entry["reuseCount"] = json!(reuse_count);
        items.push((issues.len(), item.title.clone(), entry));
    }
    // Worst first, then by title (a stable sort, as `Array#sort`).
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_compare(&a.1, &b.1)));

    json!({
        "checked": with_password.len(),
        "healthy": healthy,
        "weak": weak,
        "reused": reused,
        "old": old,
        "items": items.into_iter().map(|(_, _, entry)| entry).collect::<Vec<_>>(),
    })
}
