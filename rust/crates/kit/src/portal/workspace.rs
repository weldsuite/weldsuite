//! The workspace a public portal request names by slug (`?slug=` or the
//! sign-in body), looked up in the master database and cached for five
//! minutes. The database read stays with the caller (the kit has no
//! database): [`resolve_slug`] owns the cache, the exact match and the
//! "unknown looks like no access" rule.

use std::future::Future;

use serde::{Deserialize, Serialize};

use super::signin::Namespace;
use super::slug::normalize_portal_slug;
use super::tokens::{PortalKv, kv_get_json, kv_put_json};

/// The workspace lookup cached under [`Namespace::slug_key`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSlugEntry {
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub name: String,
}

/// The workspace lookup by slug is cached this long.
pub const SLUG_TTL_SECONDS: u64 = 300;

/// The workspace of `raw_slug`; `None` for a slug that is not a workspace's
/// (malformed, unknown or inactive). The slug is matched exactly: there is no
/// prefix fallback, so a request cannot enumerate workspaces. `load` reads
/// the master database on a cache miss and returns `None` for an unknown or
/// inactive workspace.
///
/// # Errors
/// The cache or `load` failed.
pub async fn resolve_slug<F, Fut>(
    kv: &PortalKv,
    ns: Namespace,
    raw_slug: &str,
    load: F,
) -> Result<Option<(String, PortalSlugEntry)>, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Option<PortalSlugEntry>, String>>,
{
    let Some(slug) = normalize_portal_slug(Some(raw_slug)) else {
        return Ok(None);
    };
    let key = ns.slug_key(&slug);
    if let Some(entry) = kv_get_json::<PortalSlugEntry>(kv, &key)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(Some((slug, entry)));
    }
    let Some(found) = load(slug.clone()).await? else {
        return Ok(None);
    };
    if found.clerk_org_id.is_empty() {
        return Ok(None);
    }
    kv_put_json(kv, &key, &found, SLUG_TTL_SECONDS)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some((slug, found)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use weldsuite_ports::{DynCache, MemoryCache};

    use super::*;

    #[tokio::test]
    async fn a_slug_is_looked_up_once_and_cached() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        let kv: PortalKv = Some(cache);
        let loads = AtomicU32::new(0);
        let ns = Namespace("t");
        for _ in 0..2 {
            let found = resolve_slug(&kv, ns, " Acme ", |slug| {
                loads.fetch_add(1, Ordering::SeqCst);
                async move {
                    assert_eq!(slug, "acme");
                    Ok(Some(PortalSlugEntry {
                        workspace_id: "ws_1".into(),
                        clerk_org_id: "org_1".into(),
                        name: "Acme".into(),
                    }))
                }
            })
            .await
            .expect("resolved")
            .expect("found");
            assert_eq!(found.0, "acme");
            assert_eq!(found.1.workspace_id, "ws_1");
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        // Malformed and unknown slugs read as no workspace, nothing cached.
        assert!(
            resolve_slug(&kv, ns, "%", |_| async { Ok(None) })
                .await
                .expect("ok")
                .is_none()
        );
        assert!(
            resolve_slug(&kv, ns, "other", |_| async { Ok(None) })
                .await
                .expect("ok")
                .is_none()
        );
    }
}
