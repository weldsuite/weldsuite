//! Which platform permissions an agent may be granted, and by whom
//! (`packages/domains/agent/src/grants.ts`).

use weldsuite_catalogs::permission_keys;
use weldsuite_permissions::{PermissionSubject, has_app_permission, has_permission};

/// Self-management and settings noise are never granted: agents act on data
/// objects.
const NEVER_GRANTED: [&str; 6] = [
    "weldagent:",
    "team:",
    "roles:",
    "apikeys:",
    "billing:",
    "general:",
];

/// Keys that turn on the sandbox and web tools. They run at Anthropic on
/// Global and are not available on the Kubernetes editions (`agent-sandbox`,
/// plan "What is hidden on EU"), so they are never offered or granted here.
const SANDBOX_GRANTS: [&str; 2] = ["computer:use", "browser:use"];

/// `grantableAgentPermissions()`: catalog keys an agent may hold, in catalog
/// order. `sandbox` is false on the Kubernetes editions, where the sandbox and
/// web grants are not offered.
pub fn grantable_agent_permissions(sandbox: bool) -> Vec<String> {
    permission_keys::ALL
        .iter()
        .copied()
        .filter(|key| !NEVER_GRANTED.iter().any(|prefix| key.starts_with(prefix)))
        .filter(|key| sandbox || !SANDBOX_GRANTS.contains(key))
        .map(str::to_owned)
        .collect()
}

/// `granterHolds(subject, perm)`: agent grants are plain catalog keys
/// (`people:read`) while a person's may be per app (`weldcrm:people:read`), so
/// a grant in any app counts; their own denies apply.
pub fn granter_holds<P: PermissionSubject + ?Sized>(subject: &P, perm: &str) -> bool {
    // The TypeScript twin checks the plain list without the denies; a person's
    // own denies must apply (its comment says so), so they do here.
    if has_permission(subject.denies(), perm) {
        return false;
    }
    has_permission(subject.permissions(), perm) || has_app_permission(subject, perm, None)
}

/// `splitGrantable(requested, granter)`: the requested grants the granter may
/// give, and those they may not. Granting an agent more than you hold would
/// let you act beyond your role through it.
#[allow(clippy::similar_names)]
pub fn split_grantable<P: PermissionSubject + ?Sized>(
    requested: &[String],
    who: &P,
    sandbox: bool,
) -> (Vec<String>, Vec<String>) {
    let grantable = grantable_agent_permissions(sandbox);
    let mut granted: Vec<String> = Vec::new();
    let mut refused: Vec<String> = Vec::new();
    for perm in requested {
        if granted.contains(perm) || refused.contains(perm) {
            continue;
        }
        if grantable.contains(perm) && granter_holds(who, perm) {
            granted.push(perm.clone());
        } else {
            refused.push(perm.clone());
        }
    }
    (granted, refused)
}

#[cfg(test)]
mod tests {
    use weldsuite_permissions::Grants;

    use super::*;

    fn grants(keys: &[&str]) -> Grants {
        Grants {
            permissions: keys.iter().map(|k| (*k).to_owned()).collect(),
            denies: Vec::new(),
        }
    }

    #[test]
    fn self_management_and_sandbox_grants_are_not_offered() {
        let keys = grantable_agent_permissions(false);
        assert!(keys.iter().any(|k| k == "people:read"));
        assert!(!keys.iter().any(|k| k.starts_with("weldagent:")));
        assert!(!keys.iter().any(|k| k.starts_with("billing:")));
        assert!(
            !keys
                .iter()
                .any(|k| k == "computer:use" || k == "browser:use")
        );
    }

    #[test]
    fn a_granter_gives_only_what_they_hold() {
        let me = grants(&["people:read", "tickets:*"]);
        let want = vec![
            "people:read".to_owned(),
            "people:create".to_owned(),
            "tickets:read".to_owned(),
            "people:read".to_owned(),
            "weldagent:manage".to_owned(),
        ];
        let (granted, refused) = split_grantable(&want, &me, false);
        assert_eq!(granted, ["people:read", "tickets:read"]);
        assert_eq!(refused, ["people:create", "weldagent:manage"]);
    }

    #[test]
    fn a_deny_beats_a_grant() {
        let me = Grants {
            permissions: vec!["people:*".to_owned()],
            denies: vec!["people:create".to_owned()],
        };
        assert!(granter_holds(&me, "people:read"));
        assert!(!granter_holds(&me, "people:create"));
    }
}
