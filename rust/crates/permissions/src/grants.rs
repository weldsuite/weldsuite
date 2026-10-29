//! What a member may hand out (`grants.ts`).
//!
//! Every write that widens someone's access (a role, per-member extras, a role
//! assignment) is checked:
//!
//! 1. only real keys: unknown strings are refused, since a later catalog
//!    addition would silently make them live;
//! 2. no workspace-wide wildcard: `*` and `*:<action>` belong to the owner;
//! 3. a ceiling: the grantor must hold every key they grant.
//!
//! Keys the target already has are not re-checked; only additions must pass.

use std::collections::HashSet;

use crate::app_scope::{LEGACY_UNQUALIFIED_GRANTS, PermissionSubject, parse_permission_key};
use crate::catalog::{KNOWN_KEYS, is_custom_object_permission};
use crate::engine::has_permission;

const MAX_KEY_LENGTH: usize = 200;

/// `/^[a-z0-9_*-]+$/i`.
fn is_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'*' | b'-'))
}

/// May `key` be granted at all? A concrete key must exist; a wildcard pattern
/// must cover at least one existing key and may not start with `*`.
pub fn is_grantable_permission_key(key: &str) -> bool {
    // Non-ASCII keys fail the segment check, so counting bytes instead of
    // UTF-16 units changes nothing.
    if key.is_empty() || key.len() > MAX_KEY_LENGTH {
        return false;
    }
    if !key.split(':').all(is_key_segment) || key.starts_with("*:") || key == "*" {
        return false;
    }
    if KNOWN_KEYS.contains(key) || is_custom_object_permission(key) {
        return true;
    }
    key.contains('*') && KNOWN_KEYS.iter().any(|known| has_permission(&[key], known))
}

/// Does the grantor hold `key` themselves, deny-aware? A wildcard pattern
/// passes only when the grantor's own grants cover it as a pattern.
pub fn can_grant_permission<P: PermissionSubject + ?Sized>(grantor: &P, key: &str) -> bool {
    let unqualified = if key.contains('*') {
        None
    } else {
        let parsed = parse_permission_key(key);
        parsed.app.map(|_| parsed.unqualified)
    };

    let denies = grantor.denies();
    if has_permission(denies, key) || unqualified.is_some_and(|u| has_permission(denies, u)) {
        return false;
    }
    has_permission(grantor.permissions(), key)
        || unqualified
            .is_some_and(|u| LEGACY_UNQUALIFIED_GRANTS && has_permission(grantor.permissions(), u))
}

/// The outcome of [`check_permission_grants`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PermissionGrantCheck {
    pub ok: bool,
    /// Keys that are not permissions at all (unknown, malformed, `*`).
    pub invalid: Vec<String>,
    /// Real keys the grantor does not hold and so may not hand out.
    pub not_held: Vec<String>,
}

/// Check the full list someone wants to write; `already_granted` is what the
/// target has now, kept without re-checking.
pub fn check_permission_grants<P: PermissionSubject + ?Sized, R: AsRef<str>, A: AsRef<str>>(
    grantor: &P,
    requested: &[R],
    already_granted: &[A],
) -> PermissionGrantCheck {
    let existing: HashSet<&str> = already_granted.iter().map(AsRef::as_ref).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut check = PermissionGrantCheck::default();
    for key in requested.iter().map(AsRef::as_ref) {
        if !seen.insert(key) || existing.contains(key) {
            continue;
        }
        if !is_grantable_permission_key(key) {
            check.invalid.push(key.to_owned());
        } else if !can_grant_permission(grantor, key) {
            check.not_held.push(key.to_owned());
        }
    }
    check.ok = check.invalid.is_empty() && check.not_held.is_empty();
    check
}
