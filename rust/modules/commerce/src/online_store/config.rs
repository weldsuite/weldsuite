//! What the online store needs from the install: where free shop addresses
//! live, what custom domains point at, the secret the renderer and the
//! signed tokens share, cert-manager for custom domains, and the public
//! bucket for static deployments.

use std::sync::Arc;

use weldsuite_custom_domains::CertManagerHosts;
use weldsuite_ports::{DynCache, DynFileStore};

/// Labels nobody may claim as a free address.
pub(crate) const RESERVED_LABELS: &[&str] = &[
    "www",
    "shop",
    "shops",
    "store",
    "app",
    "api",
    "admin",
    "mail",
    "smtp",
    "imap",
    "pop",
    "ftp",
    "ns",
    "ns1",
    "ns2",
    "dns",
    "cdn",
    "static",
    "assets",
    "img",
    "images",
    "help",
    "support",
    "status",
    "docs",
    "blog",
    "login",
    "signin",
    "account",
    "accounts",
    "auth",
    "id",
    "billing",
    "weldsuite",
    "weldcommerce",
    "test",
    "dev",
    "staging",
    "preview",
    "internal",
    "localhost",
];

/// The online store's settings and ports (storefronts plan). Everything is
/// optional: without a base domain there are no free addresses, without
/// cert-manager no custom domains, without the secret no renderer or
/// previews, without the bucket no static deployments; each route says so
/// with a 503 `FEATURE_UNAVAILABLE`.
#[derive(Clone, Default)]
pub struct OnlineStoreConfig {
    /// `STOREFRONT_BASE_DOMAIN`: free addresses are `{slug}.<base>`
    /// (`weldshop.eu`; `shop.localhost` in development).
    pub base_domain: Option<String>,
    /// `STOREFRONT_CNAME_TARGET`: what a custom domain's CNAME names.
    pub cname_target: Option<String>,
    /// `STOREFRONT_APEX_ADDRESSES`: the ingress addresses an apex domain's
    /// A records name.
    pub apex_addresses: Vec<String>,
    /// `https`, or `http` in development (`STOREFRONT_SCHEME`).
    pub scheme: String,
    /// The port shop URLs carry in development (`STOREFRONT_PUBLIC_PORT`).
    pub public_port: Option<u16>,
    /// `STOREFRONT_RENDERER_SECRET`: the renderer's credential, and the key
    /// preview and password tokens are signed with.
    pub secret: Option<String>,
    /// Custom domains through cert-manager; `None`: not offered.
    pub domains: Option<Arc<CertManagerHosts>>,
    /// The public bucket, for static deployments.
    pub files: Option<Arc<dyn DynFileStore>>,
    /// Host lookups; without it every lookup reads the master database.
    pub cache: Option<Arc<dyn DynCache>>,
}

impl std::fmt::Debug for OnlineStoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnlineStoreConfig")
            .field("base_domain", &self.base_domain)
            .field("cname_target", &self.cname_target)
            .field("scheme", &self.scheme)
            .field("public_port", &self.public_port)
            .field("domains", &self.domains.is_some())
            .field("files", &self.files.is_some())
            .finish_non_exhaustive()
    }
}

impl OnlineStoreConfig {
    /// The scheme shop URLs use.
    pub(crate) fn scheme(&self) -> &str {
        if self.scheme.is_empty() {
            "https"
        } else {
            &self.scheme
        }
    }

    /// `https://host` (with the development port when there is one).
    pub(crate) fn origin(&self, host: &str) -> String {
        match self.public_port {
            Some(port) => format!("{}://{host}:{port}", self.scheme()),
            None => format!("{}://{host}", self.scheme()),
        }
    }

    /// What custom domains point at: the configured target, else
    /// cert-manager's.
    pub(crate) fn cname_target(&self) -> Option<String> {
        self.cname_target.clone().or_else(|| {
            self.domains
                .as_ref()
                .map(|domains| domains.target().host.clone())
        })
    }
}
