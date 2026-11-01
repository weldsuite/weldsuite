//! `portal-slug.ts`: the workspace slug a public portal request names
//! (`?slug=` or `X-Workspace-Slug`), validated before it reaches the cache
//! key or the master database, and matched exactly.

use weldsuite_kit::validation::js_trim;

/// `PORTAL_SLUG_PATTERN`: `^[a-z0-9-]{1,100}$`.
fn is_slug(slug: &str) -> bool {
    (1..=100).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `normalizePortalSlug`: trimmed, lowercased and validated; `None` when it
/// is missing or not shaped like a workspace slug.
pub fn normalize_portal_slug(raw: Option<&str>) -> Option<String> {
    let slug = js_trim(raw?).to_lowercase();
    is_slug(&slug).then_some(slug)
}

/// `readRawSlug`: `c.req.query('slug') || c.req.header('X-Workspace-Slug')`.
pub fn raw_slug<'a>(query: Option<&'a str>, header: Option<&'a str>) -> Option<&'a str> {
    query
        .filter(|q| !q.is_empty())
        .or_else(|| header.filter(|h| !h.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_normalised_and_checked() {
        assert_eq!(
            normalize_portal_slug(Some(" Acme-1 ")),
            Some("acme-1".to_owned())
        );
        assert_eq!(normalize_portal_slug(Some("%")), None);
        assert_eq!(normalize_portal_slug(Some("a.b")), None);
        assert_eq!(normalize_portal_slug(Some("")), None);
        assert_eq!(normalize_portal_slug(None), None);
        assert_eq!(normalize_portal_slug(Some(&"a".repeat(101))), None);
        assert_eq!(raw_slug(Some(""), Some("x")), Some("x"));
        assert_eq!(raw_slug(Some("q"), Some("x")), Some("q"));
    }
}
