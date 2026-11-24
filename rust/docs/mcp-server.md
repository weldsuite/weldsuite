# The MCP server on Kubernetes

WeldSuite's MCP server (`apps/workers/mcp-server`, `mcp.weldsuite.org` on
Global) exposes a workspace to AI clients. On the Kubernetes editions it is
`modules/mcp` (package `weldsuite-mcp`), served by `weldsuite serve` at `/mcp`
(one server serves every path, OPS-013). The EU values give it a host of its
own, as Global has: AI clients connect to `https://mcp.<domain>/mcp`, the
origin `config.mcp.serverUrl` sets and the discovery documents name, and
that host's ingress routes only `/mcp` and the two `/.well-known/oauth-*`
paths.

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
- **Tools.** 290 static tools in 11 groups (`src/tools/*`: crm 40, reach 38,
  workspace 36, projects 35, weldflow 31, chat 30, social 28, mail 20,
  helpdesk 11, knowledge 11, and the domain and time-entry tools 10; the
  product and order tools left with WeldCommerce), each declarative: name, scope,
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
  manager, the knowledge-page tree walk is cycle-safe, WeldReach mounts no reply route (MCP never sends
  mail), `/v1/social-approvals` and `/v1/social-media/upload` exist only here,
  and `/v1/user-apps` has only `agent-tools`, list, create, detail, versions
  and submit. No `accounting`, `categories`, `orders`, `products` or
  `mail-sending` groups. An
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
  come from the same lookups the `/api` pipeline uses. Opaque Clerk
  tokens (`oat_…`, verified only by Clerk's API) are refused.
- **Discovery.** It names the edition's issuer (`OIDC_ISSUER`, or Clerk's
  from `CLERK_PUBLISHABLE_KEY`) and follows the sign-in (`auth::Discovery`).
  With Clerk the protected-resource document is Global's, field for field,
  and `/.well-known/oauth-authorization-server` passes Clerk's RFC 8414
  metadata through. With `AUTH_PROVIDER=oidc` the protected-resource
  document carries RFC 9728's fields only (`resource`,
  `authorization_servers`, `scopes_supported`, `bearer_methods_supported`),
  not Clerk's paths, and the authorization-server document is the
  provider's `/.well-known/openid-configuration` (Zitadel serves no RFC 8414
  document; §5 of the RFC makes the two the same). `scopes_supported` is
  what a client must ask for, the scopes the platform asks for: `openid
  profile email offline_access`, and with a Zitadel org claim
  (`OIDC_ORG_CLAIM` starting `urn:zitadel:`) also
  `urn:zitadel:iam:org:projects:roles` (the roles claim that names the
  organization) and `urn:zitadel:iam:org:project:id:<OIDC_AUDIENCE>:aud`
  (the project in `aud`).
- **An MCP client on Zitadel.** Zitadel has no dynamic client registration,
  so each client is an application in the WeldSuite project (the project
  `OIDC_AUDIENCE` names), registered by hand: the client's redirect URI,
  code flow with PKCE, refresh tokens, and **JWT access tokens** (the
  verifier takes no opaque token). The user gives the client its client id
  (and secret, for a confidential app). The organization comes from the
  roles claim, so an account with roles in several organizations gets a
  token that names none, and `/mcp` answers 401: the platform narrows its
  token with `urn:zitadel:iam:org:roles:id:<org id>`, which an MCP client
  can't know to ask for. Until `/mcp` can be told the workspace some other
  way, MCP on a Zitadel edition is for accounts in one workspace.
- **An MCP client on WeldID (membership mode,
  `OIDC_WORKSPACE_SOURCE=header`): the workspace is picked while signing
  in.** A platform token names no workspace (SEC-019), and an MCP client
  can't send the platform's `X-Weld-Workspace`. So WeldID's tenant
  selection asks: for an authorization request with an RFC 8707
  `resource` (every MCP client sends the server's URL), WeldID sends the
  browser after its consent screen to `tenant_selection_url`, the
  platform's `/auth/mcp-workspace?challenge=…`. That page calls
  `GET /api/mcp/workspace-selections/{challenge}` (`src/selection.rs`;
  signed in, no workspace) for the app's name and the person's workspaces,
  and `POST` with `{ workspaceId }` (or `{ decision: "deny" }`) to record
  the answer through WeldID's admin API (`weldid:tenants`,
  `WorkspaceSelections` port, `WeldIdWorkspaceSelections` adapter); the
  browser then goes back to WeldID, which gives the client its code. Every
  access token of that grant, refreshed ones included, carries the choice
  as the `tenant` claim (`workspaces.id`, opaque to WeldID), and every
  request checks it against the master `user_workspaces` with the same
  `WorkspaceSelector` as the header: someone who leaves the workspace loses
  the connection (403). A challenge that is unknown, expired, used or
  another person's is one 404. The page continues without asking when the
  resource names a workspace the person is in (`/mcp/w/<workspace>`), or
  the person has only one. A malformed `tenant` claim is 403.
- **The workspace URL still works**: `/mcp/w/<workspace>` (its
  `workspaces.id`, slug or organization id, in URL-unreserved characters)
  names the workspace for a client set up that way, or one whose sign-in
  had no workspace step; with a `tenant` claim too, both must name the same
  workspace (403 otherwise). A token with neither takes the user's only
  workspace; with none it answers 403. A workspace the user isn't an active
  member of is 403, unknown or foreign alike. With a token that names its
  workspace (claim mode, Clerk) a workspace URL must name that one, by id or
  organization id.
- **The workspace picker** (`src/picker.rs`). A connection whose token
  names no workspace (made before the workspace step, or by a client that
  sends no `resource`) for an account in several workspaces connects
  anyway, since a refusal shows the person only "Couldn't connect"
  (claude.ai, 2026-11-22): `initialize` tells the assistant that no
  workspace was chosen, and `tools/list` has one tool, `list_workspaces`,
  which lists the account's live, active workspaces by name and says to
  disconnect and connect again (signing in then asks which workspace),
  with each workspace's `/mcp/w/<slug>` address as the alternative (the id
  where the slug isn't a URL segment; at most 50). Where signing in doesn't
  ask (no WeldID), it says to connect with an address. It never acts in a
  workspace: no other tool or resource, no tenant database, no permission
  lookup, no rate limit. The list is the master `workspaces` and
  `user_workspaces` through the ORM
  (`WorkspaceSelector::member_workspace_list`).
- **Refusals are logged.** Every 401 and 403 of `/mcp` logs its reason
  (`mcp auth: 401`, `mcp auth: 403`, field `diagnostic`), since the client
  shows none of it; the metrics count them per status
  (`weldsuite_http_requests_total{route="/mcp"}`).
- **Clients on WeldID register themselves.** Unlike Zitadel, WeldID takes
  MCP clients without anyone setting them up, on the platform issuer only
  (WeldID's `ARCHITECTURE.md`, "Registered clients"): a client ID metadata
  document (an `https://` client id, as claude.ai and Claude Code send) or
  RFC 7591 registration at `https://auth.<domain>/register` (a `dcr_…` id).
  The `weldid-switch` layer turns both on and lists the server's URLs as
  RFC 8707 resources (`rust/deploy/flux/apps/weldid-switch/values/weldid.yaml`), so the
  authorization-server document passed through here names
  `registration_endpoint` and `client_id_metadata_document_supported`. Such
  a client is public (PKCE), is asked for consent, and gets access tokens for
  `weldsuite-api`, the audience this server verifies. WeldID gives it the
  code and refresh grants only: an extension grant it lists (claude.ai's
  `urn:ietf:params:oauth:grant-type:jwt-bearer`) is not granted. WeldID
  0.1.0-alpha.2 refused the whole document for it, so claude.ai couldn't
  sign in; 0.1.0-alpha.3 (weldsuite/weldid#26) ignores the extension grant.
- **One resource per URL (RFC 9728).** The 401's `WWW-Authenticate` points
  at the metadata of the URL the client called
  (`/.well-known/oauth-protected-resource/mcp`, or `…/mcp/w/<workspace>`),
  and each document's `resource` is exactly that URL, as §3.3 requires of a
  document found through the challenge. Global's worker points at `…/mcp`
  the same way.
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
