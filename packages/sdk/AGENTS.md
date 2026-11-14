# Published SDKs and WeldApps (`packages/sdk`)

These packages are published for use outside WeldSuite, under permissive
licences (MIT) so they can be embedded without AGPL obligations. Read the root
`AGENTS.md` first; this file adds what is specific to the SDKs.

| Package | What it is | Must stay in step with |
|---|---|---|
| `app-sdk` (`@weldsuite/app-sdk`) | Bridge, typed API client and React hooks for WeldApps | The platform host (`apps/web/platform/app/weldapps/host/`) and the CLI's local shell (`cli/src/local-shell/html.ts`) |
| `cli` (`@weldsuite/cli`) | The `weld` command: `weld app init/create/deploy/publish`, `weld skill install` | `cli/src/manifest.ts` is a copy of the `weldapp.json` schema in `@weldsuite/app-api-client/schemas/user-apps` |
| `helpdesk-widget-sdk` | Embeds the WeldDesk chat widget | `apps/web/helpdesk-widget/test-local.html` mirrors `src/core/IframeManager.ts` |
| `forms-embed` | Embeds WeldForms forms (inline, popup, slider, …) | The forms-portal embed view and `apps/web/platform/app/weldforms/share/embed-snippet.ts` (same attribute names) |
| `panel-sdk` | WeldPanel analytics for websites and web apps | `apps/workers/panel-ingest` |
| `cursor-plugin` | Connects Cursor to WeldFlow tasks | |

A protocol change lands on both sides in one PR. Keep these packages free of
internal imports a consumer can't install, and keep their READMEs current:
they are the public documentation.

## WeldApps

Users build their own apps for the platform: static bundles hosted in R2,
rendered in a sandboxed iframe at `/apps/{code}`, distributed through the App
Store (`private`: the authoring workspace only; `public`: everyone, after
manual review), optionally paid through Stripe Connect. First-party ones live
in `apps/hosted-apps/`.

- **Master DB** (`packages/core/db/src/schema/user-apps.ts`): `user_apps`,
  `user_app_versions`, `user_app_installs` (a workspace's consent grant),
  `user_app_tokens` (`wsat_` tokens, stored as SHA-256 hashes),
  `user_app_oauth_clients`, `user_app_dev_sessions`, `app_developer_accounts`.
- **Tenant DB**: apps store data only in the generic `app_records` and
  `app_kv` tables (`user-app-data.ts`). **An app never gets its own tables.**
- **Manifest** (`weldapp.json`): Zod schema in
  `@weldsuite/app-api-client/schemas/user-apps`, copied into the CLI. It
  declares scopes, storage collections and `agentTools`, which the MCP server
  exposes automatically.
- **APIs**: management in `apps/workers/app-api/src/routes/user-apps/` (member
  session); the CLI surface in
  `apps/workers/external-api/src/routes/v1/user-apps.ts` (`wsk_` keys, scope
  `user-apps:manage`); the data plane at external-api `/v1/app-storage`, with
  OAuth `client_credentials` at `/v1/oauth/token`.
- **Bridge protocol 2: no token in the iframe.** The host makes the app's API
  calls (the `fetch` bridge method) with the member's session. Community apps
  go through app-api `/api/user-apps/code/:code/gateway/v1/*`, which swaps the
  session for a server-cached `wsat_` token and forwards to external-api over
  the `EXTERNAL_API` binding, where scopes are enforced.
- **Platform UI**: host and bridge in `apps/web/platform/app/weldapps/host/`
  (frames stay alive in the shell's frame layer, positioned over the page slot
  by `frame-store.ts`), developer pages in `app/weldapps/manage/`, the store
  section in `app/appstore/custom-apps-section.tsx`. Permissions:
  `weldapps:read|develop|publish|manage`.
- **Scaffold**: `cli/templates/app/` is what `weld app init` writes, including
  the agent guidance and the `weldsuite-app` skill an app's developer gets.
  Change it when the SDK or manifest changes.

Design and decisions: `design/modules/weldapps.md` and the `APPS-*` ADRs in
`weldsuite-documentation`.
