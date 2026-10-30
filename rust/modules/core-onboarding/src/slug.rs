//! Workspace slugs (`workspace-worker/src/lib/slug.ts` and
//! `@weldsuite/app-api-client/schemas/workspace-slug`): derived from the
//! workspace's name, unique among the workspaces.

use unicode_normalization::UnicodeNormalization;
use weldsuite_db::PgPool;

const MAX_BASE_LENGTH: usize = 40;
const FALLBACK_SLUG: &str = "workspace";
const SUFFIX_LENGTH: usize = 5;

/// `RESERVED_WORKSPACE_SLUGS`: words the platform uses at the root of a URL
/// (kept in step with the TypeScript list; module crates don't share code).
const RESERVED_SLUGS: &[&str] = &[
    "www",
    "app",
    "api",
    "admin",
    "mail",
    "support",
    "help",
    "agents",
    "apps",
    "appstore",
    "auth",
    "call-room",
    "documents",
    "invite",
    "new-chat",
    "objects",
    "onboarding",
    "preview",
    "settings",
    "social",
    "welcome",
    "weldads",
    "weldbooks",
    "weldcalendar",
    "weldcall",
    "weldchat",
    "weldcommerce",
    "weldconnect",
    "weldcrm",
    "welddata",
    "welddesk",
    "welddocs",
    "welddrive",
    "weldflow",
    "weldhost",
    "weldhr",
    "weldknow",
    "weldmail",
    "weldmeet",
    "weldpanel",
    "weldpass",
    "weldreach",
    "weldsheets",
    "weldsign",
    "weldstash",
    "assets",
    "email",
    "logos",
    "models",
    "sounds",
];

/// `SLUG_REGEX`: `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`.
pub(crate) fn slug_format(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let n = bytes.len();
    (3..=63).contains(&n)
        && bytes[0].is_ascii_lowercase()
        && (bytes[n - 1].is_ascii_lowercase() || bytes[n - 1].is_ascii_digit())
        && bytes[1..n - 1]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `isReservedWorkspaceSlug`.
pub(crate) fn is_reserved(slug: &str) -> bool {
    RESERVED_SLUGS.contains(&slug.to_lowercase().as_str())
}

/// `slugifyWorkspaceName`: "QA Test 2026-09-29" → `qa-test-2026-09-29`.
/// Always a valid slug that isn't reserved; uniqueness is the caller's.
pub fn slugify_workspace_name(name: &str) -> String {
    let folded: String = name
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    let mut dashed = String::with_capacity(folded.len());
    let mut in_gap = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            dashed.push(c);
            in_gap = false;
        } else if !in_gap {
            dashed.push('-');
            in_gap = true;
        }
    }
    let trimmed = dashed.trim_matches('-');
    let cut: String = trimmed.chars().take(MAX_BASE_LENGTH).collect();
    let mut slug = cut.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        return FALLBACK_SLUG.to_owned();
    }
    if !slug.starts_with(|c: char| c.is_ascii_lowercase()) || slug.len() < 3 || is_reserved(&slug) {
        slug = format!("{FALLBACK_SLUG}-{slug}");
    }
    if slug_format(&slug) {
        slug
    } else {
        FALLBACK_SLUG.to_owned()
    }
}

/// `withRandomSuffix`: `slug-` and five random lowercase letters or digits.
pub fn with_random_suffix(slug: &str) -> String {
    format!(
        "{slug}-{}",
        weldsuite_kit::random_string(SUFFIX_LENGTH, "0123456789abcdefghijklmnopqrstuvwxyz")
    )
}

async fn taken(master: &PgPool, slug: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>("select exists (select 1 from workspaces where slug = $1)")
        .bind(slug)
        .fetch_one(master)
        .await
}

/// `resolveUniqueSlug`: `base` (or the slug derived from it when it isn't
/// one, or is reserved), then with the workspace id's tail, then counted.
pub(crate) async fn resolve_unique_slug(
    master: &PgPool,
    requested: &str,
    workspace_id: &str,
) -> Result<String, sqlx::Error> {
    let base = if slug_format(requested) && !is_reserved(requested) {
        requested.to_owned()
    } else {
        slugify_workspace_name(requested)
    };
    let tail: String = {
        let chars: Vec<char> = workspace_id.chars().collect();
        chars[chars.len().saturating_sub(6)..].iter().collect()
    };
    for candidate in [base.clone(), format!("{base}-{tail}")] {
        if !taken(master, &candidate).await? {
            return Ok(candidate);
        }
    }
    for i in 2..100 {
        let candidate = format!("{base}-{tail}-{i}");
        if !taken(master, &candidate).await? {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{workspace_id}"))
}

/// `pickNewOrgSlug`: the name's slug, else with a random suffix (five tries).
pub(crate) async fn pick_new_org_slug(master: &PgPool, name: &str) -> Result<String, sqlx::Error> {
    let base = slugify_workspace_name(name);
    let mut candidate = base.clone();
    for _ in 0..5 {
        if !taken(master, &candidate).await? {
            return Ok(candidate);
        }
        candidate = with_random_suffix(&base);
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_from_names() {
        assert_eq!(
            slugify_workspace_name("QA Test 2026-09-29"),
            "qa-test-2026-09-29"
        );
        assert_eq!(slugify_workspace_name("Café Zoë"), "cafe-zoe");
        assert_eq!(slugify_workspace_name("  --  "), "workspace");
        assert_eq!(slugify_workspace_name("42"), "workspace-42");
        assert_eq!(slugify_workspace_name("Admin"), "workspace-admin");
        assert_eq!(slugify_workspace_name("ab"), "workspace-ab");
        let long = slugify_workspace_name(&"abc ".repeat(20));
        assert!(
            long.len() <= MAX_BASE_LENGTH && !long.ends_with('-'),
            "{long}"
        );
        let suffixed = with_random_suffix("acme");
        assert!(
            suffixed.starts_with("acme-") && suffixed.len() == 10,
            "{suffixed}"
        );
        assert!(slug_format(&suffixed));
    }
}
