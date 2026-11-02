//! `cron/domain-auto-renew.ts`, the daily 04:00 UTC sweep (`weldsuite cron
//! domain-auto-renew`): it invoices each due Realtime Register domain on
//! the workspace's Stripe customer and renews it at the registrar once the
//! invoice is paid.
//!
//! Billing is Global's (Stripe, feature `billing`), so this backend has no
//! `STRIPE_SECRET_KEY`, and the sweep does what the worker does without
//! one: it logs and returns the empty result, leaving the due index alone.
//! When the Kubernetes editions get a billing provider, the charge-then-
//! renew path (`services/domain-renewal-billing.ts`) is ported here.

use serde_json::{Value, json};

/// What one run did, in the worker's shape.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AutoRenewResult {
    pub workspaces_scanned: u64,
    pub workspaces_failed: u64,
    pub domains_scanned: u64,
    pub invoiced: u64,
    pub renewed: u64,
    pub pending: u64,
    pub failed: u64,
    pub skipped: u64,
}

impl AutoRenewResult {
    /// `{ workspacesScanned, … }`.
    pub fn to_json(&self) -> Value {
        json!({
            "workspacesScanned": self.workspaces_scanned,
            "workspacesFailed": self.workspaces_failed,
            "domainsScanned": self.domains_scanned,
            "invoiced": self.invoiced,
            "renewed": self.renewed,
            "pending": self.pending,
            "failed": self.failed,
            "skipped": self.skipped,
        })
    }
}

/// `runDomainAutoRenewSweep(env)`. `env` reads a setting by name.
pub fn run_domain_auto_renew(env: &dyn Fn(&str) -> Option<String>) -> AutoRenewResult {
    let configured = |name: &str| env(name).is_some_and(|v| !v.trim().is_empty());
    if !configured("REALTIME_REGISTER_API_KEY") || !configured("REALTIME_REGISTER_CUSTOMER") {
        tracing::warn!("[DomainAutoRenew] Realtime Register is not configured — skipping");
        return AutoRenewResult::default();
    }
    tracing::warn!(
        "[DomainAutoRenew] STRIPE_SECRET_KEY is not configured — skipping (billing is not available on this backend)"
    );
    AutoRenewResult::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_without_billing() {
        let result = run_domain_auto_renew(&|name| {
            name.starts_with("REALTIME_REGISTER")
                .then(|| "x".to_owned())
        });
        assert_eq!(result, AutoRenewResult::default());
        assert_eq!(result.to_json()["workspacesScanned"], 0);
    }
}
