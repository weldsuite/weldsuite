//! App-scoped checks (`app-scope.ts`).
//!
//! Objects that live inside apps are granted per app: `weldcrm:companies:read`
//! and `weldbooks:companies:read` are independent grants. Callers ask for the
//! unqualified `companies:read`; the check qualifies it with the request's
//! app. Workspace-level objects are checked as written.
//!
//! For an app-scoped key:
//! - the app is given and exposes the object → check that app;
//! - no app (MCP, API keys, agents, workflows) → allowed when any app that
//!   exposes the object grants it;
//! - the app is given but does not expose the object → the same any-app
//!   check, flagged `object_not_in_app` so the registry gap gets logged.
//!
//! A per-member deny always wins, and a deny on the unqualified key denies it
//! in every app.

use crate::apps::{apps_for_object, is_app_code, normalize_app_code};
use crate::engine::has_permission;

/// While stored grants are still unqualified (`companies:read`), they count in
/// every app. Mirrors `LEGACY_UNQUALIFIED_GRANTS`.
pub const LEGACY_UNQUALIFIED_GRANTS: bool = true;

/// A concrete key split into its app and object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionKeyParts<'a> {
    /// The app segment when the key is app-qualified.
    pub app: Option<&'a str>,
    /// `companies`.
    pub object: &'a str,
    /// The key without its app segment: `companies:scope:all`.
    pub unqualified: &'a str,
}

/// Split a concrete key. A leading app code only counts as an app segment when
/// the next segment is an object of that app, so app-named workspace objects
/// (`weldagent:use`) are never read as qualified keys.
pub fn parse_permission_key(key: &str) -> PermissionKeyParts<'_> {
    let mut segments = key.split(':');
    let first = segments.next().unwrap_or("");
    let second = segments.next().unwrap_or("");
    if segments.next().is_some() && is_app_code(first) && apps_for_object(second).contains(&first) {
        return PermissionKeyParts {
            app: Some(first),
            object: second,
            unqualified: &key[first.len() + 1..],
        };
    }
    PermissionKeyParts {
        app: None,
        object: first,
        unqualified: key,
    }
}

/// `companies:read` + `weldcrm` → `weldcrm:companies:read`. Qualified and
/// workspace-level keys come back unchanged.
pub fn qualify_permission(key: &str, app: &str) -> String {
    let parsed = parse_permission_key(key);
    if parsed.app.is_some() || apps_for_object(parsed.object).is_empty() {
        key.to_owned()
    } else {
        format!("{app}:{key}")
    }
}

/// Anything that carries grants and denies.
pub trait PermissionSubject {
    fn permissions(&self) -> &[String];
    fn denies(&self) -> &[String];
}

/// A plain grants + denies pair, for subjects that aren't a resolved member
/// (API keys, agents, tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grants {
    pub permissions: Vec<String>,
    pub denies: Vec<String>,
}

impl PermissionSubject for Grants {
    fn permissions(&self) -> &[String] {
        &self.permissions
    }

    fn denies(&self) -> &[String] {
        &self.denies
    }
}

/// How a key was evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppCheckMode {
    /// Workspace-level object: checked as written.
    Workspace,
    /// Checked in one app.
    App,
    /// Allowed when any app that exposes the object grants it.
    AnyApp,
}

/// The outcome of [`check_app_permission`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppPermissionCheck {
    pub allowed: bool,
    pub mode: AppCheckMode,
    /// The app checked against in [`AppCheckMode::App`].
    pub app: Option<&'static str>,
    /// An app was given but does not expose the object (a registry gap).
    pub object_not_in_app: bool,
}

fn is_denied<P: PermissionSubject + ?Sized>(subject: &P, keys: &[&str]) -> bool {
    let denies = subject.denies();
    !denies.is_empty() && keys.iter().any(|key| has_permission(denies, key))
}

fn allows_in_app<P: PermissionSubject + ?Sized>(
    subject: &P,
    qualified: &str,
    unqualified: &str,
) -> bool {
    if is_denied(subject, &[qualified, unqualified]) {
        return false;
    }
    has_permission(subject.permissions(), qualified)
        || (LEGACY_UNQUALIFIED_GRANTS && has_permission(subject.permissions(), unqualified))
}

/// Evaluate one concrete key, qualified or not, in the request's app context
/// (`None` when the request names no app).
pub fn check_app_permission<P: PermissionSubject + ?Sized>(
    subject: &P,
    required: &str,
    app: Option<&str>,
) -> AppPermissionCheck {
    let parsed = parse_permission_key(required);

    if let Some(qualified_app) = parsed.app {
        return AppPermissionCheck {
            allowed: allows_in_app(subject, required, parsed.unqualified),
            mode: AppCheckMode::App,
            app: registry_code(qualified_app),
            object_not_in_app: false,
        };
    }

    let apps = apps_for_object(parsed.object);
    if apps.is_empty() {
        return AppPermissionCheck {
            allowed: !is_denied(subject, &[required])
                && has_permission(subject.permissions(), required),
            mode: AppCheckMode::Workspace,
            app: None,
            object_not_in_app: false,
        };
    }

    let app_code = app.filter(|a| !a.is_empty()).and_then(normalize_app_code);
    if let Some(app_code) = app_code.filter(|code| apps.contains(code)) {
        return AppPermissionCheck {
            allowed: allows_in_app(subject, &format!("{app_code}:{required}"), required),
            mode: AppCheckMode::App,
            app: Some(app_code),
            object_not_in_app: false,
        };
    }

    AppPermissionCheck {
        allowed: apps
            .iter()
            .any(|a| allows_in_app(subject, &format!("{a}:{required}"), required)),
        mode: AppCheckMode::AnyApp,
        app: None,
        object_not_in_app: app_code.is_some(),
    }
}

/// The registry's own `&'static str` for a canonical code.
fn registry_code(code: &str) -> Option<&'static str> {
    crate::apps::get_permission_app(code).map(|app| app.code.as_str())
}

/// Boolean shorthand for [`check_app_permission`].
pub fn has_app_permission<P: PermissionSubject + ?Sized>(
    subject: &P,
    required: &str,
    app: Option<&str>,
) -> bool {
    check_app_permission(subject, required, app).allowed
}

/// Is at least one of `required` allowed in the app context?
pub fn has_any_app_permission<P: PermissionSubject + ?Sized, R: AsRef<str>>(
    subject: &P,
    required: &[R],
    app: Option<&str>,
) -> bool {
    required
        .iter()
        .any(|key| check_app_permission(subject, key.as_ref(), app).allowed)
}
