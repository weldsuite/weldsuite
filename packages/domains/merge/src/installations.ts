/**
 * Recording a GitHub App installation as a WeldMerge connection (area A).
 *
 * `recordGithubInstallation(tenantDb, masterDb, ...)` upserts the
 * `merge_connections` row and the master `merge_provider_index` row
 * (`kind = installation`), and answers what changed so the caller can publish
 * the `merge_connection` created/updated event. merge-api's public setup route
 * (`/public/merge/github/setup`) and connect-api's
 * `GET /api/weldconnect/github/callback` both call it, so the two install
 * paths cannot drift. Removal and suspend/unsuspend go through the same module.
 *
 * Foundation stub: empty until area A fills it.
 */

export {};
