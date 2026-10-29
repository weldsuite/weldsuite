//! Feature flags: the port behind `getFlags()`
//! (`packages/core/feature-flags/src/server.ts`), which asks the Cloudflare
//! Flagship binding. A [`FlagSource`] answers with the configured value of a
//! flag for a workspace, or nothing; [`FlagSourceExt`] turns that into the
//! typed value of a catalog flag (`weldsuite_catalogs::flags`), falling back
//! to the catalog default whenever the source has no answer, fails or returns
//! the wrong type. Evaluating a flag never fails, as in TypeScript.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use weldsuite_catalogs::flags::{BoolFlag, JsonFlag, NumberFlag, StringFlag};

use crate::{BoxFuture, PortError};

/// Who a flag is evaluated for: the targeting attributes of `FlagAttributes`
/// that belong to the request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlagContext {
    /// `workspaces.id` (`ws_…`).
    pub workspace_id: String,
    /// The workspace's Clerk org id, for overrides keyed by it.
    pub clerk_org_id: Option<String>,
    /// The Clerk user id.
    pub user_id: String,
}

impl FlagContext {
    /// Whether `reference` names this workspace, by either id.
    pub fn is_workspace(&self, reference: &str) -> bool {
        self.workspace_id == reference || self.clerk_org_id.as_deref() == Some(reference)
    }
}

/// Where flag values come from.
pub trait FlagSource: Send + Sync {
    /// The configured value of flag `key` for `context`, or `None` to use the
    /// catalog default.
    fn value(
        &self,
        key: &str,
        context: &FlagContext,
    ) -> impl Future<Output = Result<Option<Value>, PortError>> + Send;
}

/// Typed evaluation of catalog flags on any [`FlagSource`] (`isOn`,
/// `getValue`).
pub trait FlagSourceExt: FlagSource {
    fn is_on(&self, flag: BoolFlag, context: &FlagContext) -> impl Future<Output = bool> + Send {
        async move {
            let value = self.value(flag.key, context).await;
            typed(flag.key, value, Value::as_bool).unwrap_or(flag.default)
        }
    }

    fn string_value(
        &self,
        flag: StringFlag,
        context: &FlagContext,
    ) -> impl Future<Output = String> + Send {
        async move {
            let value = self.value(flag.key, context).await;
            typed(flag.key, value, |v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| flag.default.to_owned())
        }
    }

    fn number_value(
        &self,
        flag: NumberFlag,
        context: &FlagContext,
    ) -> impl Future<Output = f64> + Send {
        async move {
            let value = self.value(flag.key, context).await;
            typed(flag.key, value, Value::as_f64).unwrap_or(flag.default)
        }
    }

    /// A JSON flag's value; its default is parsed from the catalog.
    fn json_value(
        &self,
        flag: JsonFlag,
        context: &FlagContext,
    ) -> impl Future<Output = Value> + Send {
        async move {
            let value = self.value(flag.key, context).await;
            typed(flag.key, value, |v| Some(v.clone()))
                .unwrap_or_else(|| serde_json::from_str(flag.default_json).unwrap_or(Value::Null))
        }
    }
}

impl<S: FlagSource + ?Sized> FlagSourceExt for S {}

/// The typed value, or `None` (use the default) with a warning when the
/// source failed or answered with the wrong type.
fn typed<T>(
    key: &str,
    value: Result<Option<Value>, PortError>,
    convert: impl FnOnce(&Value) -> Option<T>,
) -> Option<T> {
    match value {
        Ok(Some(value)) => {
            let converted = convert(&value);
            if converted.is_none() {
                tracing::warn!(flag = key, %value, "feature flag: configured value has the wrong type; using the default");
            }
            converted
        }
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(flag = key, %error, "feature flag: source failed; using the default");
            None
        }
    }
}

/// Object-safe [`FlagSource`], for `Arc<dyn DynFlagSource>`.
pub trait DynFlagSource: Send + Sync {
    fn value_boxed<'a>(
        &'a self,
        key: &'a str,
        context: &'a FlagContext,
    ) -> BoxFuture<'a, Result<Option<Value>, PortError>>;
}

impl<S: FlagSource> DynFlagSource for S {
    fn value_boxed<'a>(
        &'a self,
        key: &'a str,
        context: &'a FlagContext,
    ) -> BoxFuture<'a, Result<Option<Value>, PortError>> {
        Box::pin(self.value(key, context))
    }
}

impl FlagSource for dyn DynFlagSource {
    async fn value(&self, key: &str, context: &FlagContext) -> Result<Option<Value>, PortError> {
        self.value_boxed(key, context).await
    }
}

impl<S: FlagSource + ?Sized> FlagSource for Arc<S> {
    fn value(
        &self,
        key: &str,
        context: &FlagContext,
    ) -> impl Future<Output = Result<Option<Value>, PortError>> + Send {
        (**self).value(key, context)
    }
}

/// Every flag at its catalog default: what the workers do without a Flagship
/// binding (local `wrangler dev`).
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultFlags;

impl FlagSource for DefaultFlags {
    fn value(
        &self,
        _key: &str,
        _context: &FlagContext,
    ) -> impl Future<Output = Result<Option<Value>, PortError>> + Send {
        std::future::ready(Ok(None))
    }
}

/// Fixed flag values, the test double. A per-workspace value wins over a
/// value for every workspace.
#[derive(Debug, Clone, Default)]
pub struct StaticFlags {
    everyone: HashMap<String, Value>,
    workspaces: HashMap<(String, String), Value>,
}

impl StaticFlags {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets `key` for every workspace.
    #[must_use]
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.everyone.insert(key.to_owned(), value);
        self
    }

    /// Sets `key` for one workspace (`workspaces.id` or Clerk org id).
    #[must_use]
    pub fn with_workspace(mut self, workspace: &str, key: &str, value: Value) -> Self {
        self.workspaces
            .insert((workspace.to_owned(), key.to_owned()), value);
        self
    }
}

impl FlagSource for StaticFlags {
    fn value(
        &self,
        key: &str,
        context: &FlagContext,
    ) -> impl Future<Output = Result<Option<Value>, PortError>> + Send {
        let for_workspace = self
            .workspaces
            .iter()
            .find(|((workspace, flag), _)| flag == key && context.is_workspace(workspace))
            .map(|(_, value)| value);
        let value = for_workspace.or_else(|| self.everyone.get(key)).cloned();
        std::future::ready(Ok(value))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weldsuite_catalogs::flags::{HELLO_WORLD, WELDMAIL_OUTBOUND_GUARD, WELDREACH_SENDING};

    use super::*;

    fn context() -> FlagContext {
        FlagContext {
            workspace_id: "ws_1".to_owned(),
            clerk_org_id: Some("org_1".to_owned()),
            user_id: "user_1".to_owned(),
        }
    }

    struct Broken;

    impl FlagSource for Broken {
        fn value(
            &self,
            _key: &str,
            _context: &FlagContext,
        ) -> impl Future<Output = Result<Option<Value>, PortError>> + Send {
            std::future::ready(Err(PortError::backend("down")))
        }
    }

    #[tokio::test]
    async fn defaults_without_an_answer_or_on_failure() {
        assert!(!DefaultFlags.is_on(HELLO_WORLD, &context()).await);
        assert_eq!(
            Broken.is_on(WELDREACH_SENDING, &context()).await,
            WELDREACH_SENDING.default
        );
        assert_eq!(
            Broken
                .string_value(WELDMAIL_OUTBOUND_GUARD, &context())
                .await,
            "shadow"
        );
    }

    #[tokio::test]
    async fn workspace_values_win_and_wrong_types_fall_back() {
        let flags: Arc<dyn DynFlagSource> = Arc::new(
            StaticFlags::new()
                .with(HELLO_WORLD.key, json!(true))
                .with_workspace("org_1", WELDMAIL_OUTBOUND_GUARD.key, json!("enforce"))
                .with(WELDMAIL_OUTBOUND_GUARD.key, json!("off"))
                .with(WELDREACH_SENDING.key, json!("yes")),
        );
        assert!(flags.is_on(HELLO_WORLD, &context()).await);
        assert_eq!(
            flags
                .string_value(WELDMAIL_OUTBOUND_GUARD, &context())
                .await,
            "enforce"
        );
        let other = FlagContext {
            workspace_id: "ws_2".to_owned(),
            ..FlagContext::default()
        };
        assert_eq!(
            flags.string_value(WELDMAIL_OUTBOUND_GUARD, &other).await,
            "off"
        );
        assert!(
            flags.is_on(WELDREACH_SENDING, &context()).await,
            "wrong type → default"
        );
    }
}
