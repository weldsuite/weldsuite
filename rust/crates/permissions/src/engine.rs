//! Wildcard matching for `object:action` keys (`engine.ts`).
//!
//! - `*` matches everything;
//! - `leads:*` matches any action on `leads`;
//! - `*:read` matches `read` on any object;
//! - `leads:read` matches only itself.
//!
//! The matcher walks segments generically, so three-segment keys
//! (`weldcrm:companies:read`, `weldobjects:machine:read`) match the same way.

/// Does the held permission `user_perm` (may contain wildcards) cover the
/// concrete `required` key?
fn permission_matches(user_perm: &str, required: &str) -> bool {
    if user_perm == "*" || user_perm == required {
        return true;
    }
    let user_parts: Vec<&str> = user_perm.split(':').collect();
    let required_parts: Vec<&str> = required.split(':').collect();
    let last = user_parts.len() - 1;

    for (i, part) in user_parts.iter().enumerate() {
        // A trailing `*` accepts every remaining segment.
        if *part == "*" && i == last {
            return true;
        }
        let Some(required_part) = required_parts.get(i) else {
            return false;
        };
        if *part != "*" && part != required_part {
            return false;
        }
    }
    user_parts.len() == required_parts.len()
}

/// Do the held permissions cover `required`? Ignores denies; use the
/// app-aware checks in [`crate::app_scope`] for request authorisation.
pub fn has_permission<S: AsRef<str>>(user_permissions: &[S], required: &str) -> bool {
    user_permissions
        .iter()
        .any(|held| permission_matches(held.as_ref(), required))
}

/// Do the held permissions cover at least one of `required`?
pub fn has_any_permission<S: AsRef<str>, R: AsRef<str>>(
    user_permissions: &[S],
    required: &[R],
) -> bool {
    required
        .iter()
        .any(|key| has_permission(user_permissions, key.as_ref()))
}

/// Do the held permissions cover every key in `required`?
pub fn has_all_permissions<S: AsRef<str>, R: AsRef<str>>(
    user_permissions: &[S],
    required: &[R],
) -> bool {
    required
        .iter()
        .all(|key| has_permission(user_permissions, key.as_ref()))
}

/// Any permission at all on `object_key` (sidebar and section gating).
pub fn has_object_access<S: AsRef<str>>(user_permissions: &[S], object_key: &str) -> bool {
    user_permissions.iter().any(|held| {
        let held = held.as_ref();
        held == "*"
            || held
                .strip_prefix(object_key)
                .is_some_and(|rest| rest.starts_with(':'))
            // A cross-object wildcard such as `*:read` reaches every object.
            || held.starts_with("*:")
    })
}

/// Any permission on at least one of `object_keys`.
pub fn has_any_object_access<S: AsRef<str>, O: AsRef<str>>(
    user_permissions: &[S],
    object_keys: &[O],
) -> bool {
    object_keys
        .iter()
        .any(|key| has_object_access(user_permissions, key.as_ref()))
}

/// The concrete keys of `catalog_keys` the held permissions cover, in catalog
/// order and without duplicates (the permission editor's view).
pub fn expand_wildcards<S: AsRef<str>, K: AsRef<str>>(
    user_permissions: &[S],
    catalog_keys: &[K],
) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for key in catalog_keys {
        let key = key.as_ref();
        if has_permission(user_permissions, key) && !result.iter().any(|k| k == key) {
            result.push(key.to_owned());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards() {
        assert!(has_permission(&["*"], "leads:read"));
        assert!(has_permission(&["leads:*"], "leads:scope:all"));
        assert!(has_permission(&["*:read"], "leads:read"));
        assert!(!has_permission(&["*:read"], "weldcrm:leads:read"));
        assert!(has_permission(&["weldcrm:*:read"], "weldcrm:leads:read"));
        assert!(!has_permission(&["leads"], "leads:read"));
        assert!(!has_permission(&["leads:read:extra"], "leads:read"));
        assert!(!has_permission::<&str>(&[], "leads:read"));
    }
}
