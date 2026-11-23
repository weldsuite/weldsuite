//! WeldApps rules more than one module serves: the request bodies of
//! `@weldsuite/app-api-client/schemas/user-apps` (app-api's `/api/user-apps`
//! and external-api's `/v1/user-apps`, the CLI's surface), the manifest, the
//! scope grammar and set arithmetic, reserved app codes, bundle paths and
//! their content types, and the URL rules for lifecycle webhooks and preview
//! sessions.

pub mod adopt;
pub mod schemas;
pub mod scopes;
