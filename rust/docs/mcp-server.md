# The MCP server on Kubernetes

WeldSuite's MCP server (`apps/workers/mcp-server`, `mcp.weldsuite.org` on
Global) exposes a workspace to AI clients. On the Kubernetes editions it is
`modules/mcp` (package `weldsuite-mcp`), served by `weldsuite serve` at `/mcp`
on the edition's own host (one host serves every path, OPS-013).

## What the worker is

- **Transport.** Streamable HTTP, stateless: `POST /mcp` carries one JSON-RPC
  message or a batch and is answered with JSON (`enableJsonResponse`), never
  SSE; no `Mcp-Session-Id`. A fresh `McpServer` per request
  (`lib/mcp-transport.ts`), pre-marked initialized so `tools/list` and
  `tools/call` work without a prior `initialize` on the same instance.
  `GET /mcp` (Accept `text/event-stream`) answers an SSE response that closes
  at once, `DELETE` 200, anything else 405. The SDK's own checks apply:
  Accept must list `application/json` and `text/event-stream` (406),
  `Content-Type` JSON (415), an `MCP-Protocol-Version` header it knows (400).
  The body is parsed before them: malformed JSON is the worker's 500.
- **Methods.** `initialize` (server `WeldSuite` 1.0.0, the house
  instructions, capabilities `tools` and `resources`), `ping`, `tools/list`,
  `tools/call`, `resources/list`, `resources/templates/list`,
  `resources/read` (one resource, `weldsuite://workspace/info`), and
  notifications (202). No prompts.
- **Auth.** OAuth 2.1 through Clerk as the authorization server. `/mcp` takes
  a bearer access token only (Clerk `acceptsToken: 'oauth_token'`: a browser
  session JWT is refused); a 401 carries `WWW-Authenticate: Bearer
  resource_metadata=…`. Discovery is unauthenticated:
  `/.well-known/oauth-protected-resource` (and `…/mcp`), RFC 9728, naming
  Clerk's issuer, and `/.well-known/oauth-authorization-server`, Clerk's
  metadata fetched and passed through. The token's organization (`org_id`
  claim, else Clerk's userinfo) picks the workspace (`workspaces.clerk_org_id`,
  cached in KV, the tenant URL sealed); authority is the member's **effective
  permissions** in that workspace (role, teams, member grants and denies),
  never the token's scopes. No member, or a role with no permissions: 403.
  No `wsk_` keys.
- **Rate limit.** Per workspace and plan tier, a `RateLimiter` Durable Object
  (60 a minute for `free`; the table names `starter`, `professional`,
  `enterprise`, so `business` and `scale` fall back to `free`'s 60).
- **Tools.** 300 static tools in 11 groups (`src/tools/*`: crm 40, reach 38,
  workspace 36, projects 35, weldflow 31, chat 30, social 28, mail 20,
  commerce 20, helpdesk 11, knowledge 11), each declarative: name, scope,
  description, a Zod raw shape for the input, and `method` + `path` (+
  `pathParams`, `exactId`) into the `/v1` API. Listed only when the member
  could use the scope (`canUseScope`). Then, dynamically: Clerk's
  `submit_feedback` (only with `CLERK_SECRET_KEY`), the agent tools WeldApps
  declare in their manifests (`user-apps:manage`; `GET
  /v1/user-apps/agent-tools`, named `<code>_<tool>`), and five tools per
  WeldObjects object (`custom-objects:read`; `GET
  /v1/custom-objects/agent-tools`), name collisions suffixed `_2`, `_3`.
  Each is listed with a title (`search_tasks` → "Search tasks"; a WeldApps
  tool's "App: List items") and annotations derived from the HTTP method it
  calls (`lib/tool-annotations.ts`): GET is read-only, DELETE destructive,
  PATCH/PUT idempotent, an unknown method a destructive write; a few tools
  set their own on top (`openWorldHint` when the call leaves the workspace,
  `destructiveHint` when it replaces data).
- **Calling a tool.** The SDK validates the arguments with the Zod shape (an
  error result `MCP error -32602: Input validation error: …`, one line per
  issue). `lib/proxy.ts` fills the path from the inputs, puts the rest on the
  query (GET/DELETE) or in a JSON body, and calls the worker's own copy of the
  `/v1` API **in process** (`src/api`, `apiApp.fetch`). After a 404 on a
  one-placeholder path it looks the value up by name (`?search=`) and retries
  (unless `exactId`). The answer becomes text through `lib/present.ts`
  (records as labelled lines, lists as one line per row, identifiers held
  back in HTML comments); errors become `CODE: message (details: …)`.
- **`src/api`.** A copy of external-api's `/v1` routes, mounted in the worker,
  with three differences: the session is the member's (`keyType` personal,
  `scopes` = effective permissions), `requireScope` is method-aware against the
  permission catalog (`lib/permissions.ts`: GET needs `read`, POST `create` or
  `update`, PATCH/PUT `update`, DELETE `delete`, aliases such as
  `drive`→`files`, and WeldReach's pinned action routes), and a few routes
  differ: tickets and conversations record `via: 'mcp'`, creating a project
  makes the creator its owner member and maps `ownerId` to the project
  manager, creating a product takes no generated slug, the knowledge-page
  tree walk is cycle-safe, WeldReach mounts no reply route (MCP never sends
  mail), `/v1/social-approvals` and `/v1/social-media/upload` exist only here,
  and `/v1/user-apps` has only `agent-tools`, list, create, detail, versions
  and submit. No `accounting`, `categories` or `mail-sending` groups. An
  unknown path is Hono's plain-text 404; a thrown error a plain-text 500.
  Licence and read-only gates as external-api's.
- **Bindings.** `DATABASE_URL_MASTER`/`HYPERDRIVE_MASTER` (workspace by org;
  WeldApps tables), `API_CACHE` KV (workspace and userinfo caches),
  `RATE_LIMITER` DO, `ENTITY_EVENTS` queue (every write publishes), `STORAGE`
  and `PRIVATE_STORAGE` R2 (files, social media, app bundles),
  `WORKSPACE_CACHE` KV and D1 `SCHEDULE_INDEX` (WeldReach's approval gate and
  send-due marks), `FLAGSHIP` (WeldReach's kill switch, the mailbox store
  mode), `MAILBOX_STORE`/`MAIL_INDEX` DOs and `MAIL_STORAGE` R2 (WeldMail's
  object store, unused while the mode is `postgres`), `HELPDESK_WORKFLOW`
  (WeldDesk assignment), PostPeer's key (publishing social posts).

## The Rust shape

- **One `/v1`, two callers.** The tools call the ported public API's router
  (`weldsuite_external_api::router`) in process, through `tower`'s `oneshot`,
  with the member's session as the `/v1` session and the MCP grants beside
  it: `require_scope` then applies `lib/permissions.ts` instead of the key
  rule (`weldsuite_external_api::McpGrants`). Nothing is re-implemented per
  object. The MCP copy's own route set is generated (`apiRoutes` in the
  catalog): a path the worker's copy does not mount answers its plain 404, and
  the routes that differ (above) are handled where the copy differs.
- **Catalog as data.** `tools/generate.mts` runs the TypeScript server itself:
  it registers every tool with an all-permission session and writes
  `catalog/tools.json` with what `tools/list` answers (name, title,
  description, the SDK's input JSON Schema, annotations) next to each tool's
  routing (scope, method, path, `pathParams`, `exactId`) and its Zod shape as
  data for argument validation (`src/args_gen.rs`, read by external-api's Zod
  interpreter). `initialize`'s answer (instructions included) comes from the
  same run. `tools/list` is therefore the TypeScript list by construction;
  conformance checks it. A WeldApps tool is built at run time, its title and
  annotations derived as the worker derives them (`src/annotations.rs`).
- **Presentation.** `present.rs` is `lib/present.ts`. JavaScript prints keys in
  insertion order and Drizzle rows in schema order; Rust's rows come back
  sorted, so the generator also writes every tenant table's column order and a
  row is printed in the order of the table it is, nested `jsonb` values in
  `jsonb`'s order.
- **Auth.** The bearer is verified by the server's own session verifier: with
  `AUTH_PROVIDER=oidc` (Zitadel) an access token of the issuer, the org from
  `OIDC_ORG_CLAIM`. With Clerk it is the same verifier as `/api`'s, which
  takes a token whose `typ` is `JWT` (a session token) and refuses Clerk's
  OAuth access tokens (`at+jwt`), so an MCP client can't sign in on a
  Clerk-mode Kubernetes install yet; Global's TypeScript server takes them.
  The workspace, its restrictions and the member's permissions
  come from the same lookups the `/api` pipeline uses. Discovery names the
  edition's issuer (`OIDC_ISSUER`, or Clerk's from `CLERK_PUBLISHABLE_KEY`) and
  passes its `oauth-authorization-server` metadata through. Opaque Clerk
  tokens (`oat_…`, verified only by Clerk's API) are refused.
- **Bindings on Kubernetes.** KV caches → the cache port (Valkey); the
  rate limiter → the cache's atomic counters, as external-api's; the D1
  due index → `weldsuite_db::due_index` (in the ported WeldReach routes);
  the mailbox store → Postgres (the only mode the Rust mail module has);
  Hyperdrive → the master pool; the queue → the event bus; R2 → the S3 file
  stores; `HELPDESK_WORKFLOW` → desk-domain's `AssignmentRouter`; Flagship →
  the flags port.
- **What is served.** A tool whose `/v1` group is not served on Kubernetes
  (its module not ported, or its group not yet ported in external-api) is left
  out of `tools/list`, exactly as the worker leaves out a tool the member's
  role cannot use; the README lists them. `submit_feedback` needs Clerk's
  secret key, so on Zitadel editions it is not offered (as the worker without
  `CLERK_SECRET_KEY`).
