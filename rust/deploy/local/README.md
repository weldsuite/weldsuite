# The Rust backend on your machine

The release image of the Rust backend with everything it talks to, in Docker
Compose: Postgres (migrated by `weldsuite migrate`, with one seeded workspace),
Valkey, NATS JetStream, S3 (RustFS), Restate and Mailpit. Two ways in:

- **Postman**, with session tokens `mint-token.mjs` signs for a seeded admin
  and member. No identity provider involved.
- **The platform**, the dev server on http://localhost:3000, signing in with
  your **EU test account** through EU test's Zitadel
  (`eu-test-auth.mjs`). The local workspace is then yours, and every API call
  goes to the server here.

Every credential in this directory is a throwaway for this machine.

| | |
|---|---|
| API (and the platform SPA the image carries) | http://localhost:8080 |
| Mailpit (system emails) | http://localhost:8025 |
| Sign portal | http://localhost:3010 |
| Postgres | `localhost:55433`, user `weldsuite`, password `weldsuite`, databases `master` and `tenant` |

The API serves what the image's commit marks as ported (`RUST_PORTED_MODULES`
in `packages/core/api-modules`), which by now is every module: core, CRM,
WeldDesk, WeldMail, WeldFlow, WeldBooks, WeldCommerce, WeldStash, WeldHost,
calendar, chat, telephony, WeldConnect, data, WeldKnow, HR, social, ads,
WeldPass, WeldReach, sheets, WeldSign, docs, WeldPanel, board, merge and
forms. WeldMeet needs a video service, which this stack doesn't run, and the
AI features need a provider (`AI_DEFAULT_PROVIDER`). `GET /config.json` lists
what this server offers (`modules`) and what it lacks (`unavailableFeatures`).

## Start

Needs Docker (Compose 2.24 or later) and Node 20+. From this directory:

```bash
node mint-token.mjs              # once: the session key, and tokens valid 30 days
docker compose up -d             # migrates, seeds, then starts the server
curl http://localhost:8080/readyz
```

`mint-token.mjs` again makes new tokens with the same key (`node mint-token.mjs 90`
for 90 days); the server needs no restart.

**The images.** `docker compose` runs `weldsuite:local` and
`weldsuite-sign-portal:local` unless `WELDSUITE_IMAGE` and `PORTAL_IMAGE` name
others. The "Rust images" workflow pushes both for every commit on `main`, as
`sha-` and the commit's first 12 characters, and anyone can pull them:

```bash
WELDSUITE_IMAGE=ghcr.io/weldsuite/weldsuite:sha-95ac8f662bf0 PORTAL_IMAGE=ghcr.io/weldsuite/weldsuite-sign-portal:sha-95ac8f662bf0 docker compose up -d
```

(`gh run list --workflow rust-images.yml --branch main --status success`
lists the commits that have them.) To test your own Rust changes, build them
from the repo root of a checkout with LF line endings
(`git -c core.autocrlf=false worktree add <dir> main` on Windows):

```bash
docker build -f rust/Dockerfile -t weldsuite:local .
docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:local .
```

**Stop:** `docker compose down` keeps the database; `docker compose down -v`
starts over (the sign-in you chose below stays: `docker compose up -d` seeds
it again).

## Sign in with your EU test account

The server checks EU test's Zitadel tokens instead of the minted ones, and the
seeded workspace `ws_local` answers to your EU test organization, with you as
its owner. Your account, your password and your second factor are EU test's;
the data is all on this machine. Nothing is written to EU test.

### Once per team: the localhost application

An administrator of EU test's Zitadel adds it, once. In
https://auth.test.weldsuite.eu/ui/console, open the project **WeldSuite** in
the instance's default organisation and add an application:

- name `platform-localhost`, type **User Agent**, authentication **PKCE**;
- redirect URIs `http://localhost:<port>/auth/sso-callback` and post-logout
  URIs `http://localhost:<port>/` for each port the API accepts from a dev
  server, 3000, 3001, 5173, 3202 and 3203
  (`rust/catalogs/first-party-origins.json`), and for 8080, the SPA this
  stack's image serves;
- **Development mode** on (it allows `http://` redirects);
- **Auth token type: JWT**, as the `platform` application has: the server
  verifies access tokens against Zitadel's keys and never introspects;
- login: tick **Use new Login UI** and leave its custom base URL **empty**, so
  this application signs in on Zitadel's own pages. EU test's `platform`
  application sends people to WeldSuite's sign-in screens instead
  (`signIn: platform`), which only work when the server is Zitadel's login
  client with EU test's service token; no laptop gets that token.

The same application serves `pnpm --filter platform dev:eu` against EU test
itself. Its client id is not a secret: share it with the team, who set it as
`EU_DEV_CLIENT_ID` (both `dev:eu` and `eu-test-auth.mjs` read it). EU test's
own `platform` application stays as it is. `rust/deploy/hetzner/README.md` §7
has how EU test's project and applications are set up.

### Per developer

1. **Your access token.** Sign in at https://app.test.weldsuite.eu, open the
   browser's developer tools (F12) → Console, and run:

   ```js
   copy(JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('oidc.user:'))[1]).access_token)
   ```

   The token is now on your clipboard. It only serves to read your user id,
   your organization and your name; the script doesn't keep it.

2. **Link the stack to it** (this starts the stack if it isn't running):

   ```bash
   node eu-test-auth.mjs --client-id <the localhost application's client id> --token <paste>
   ```

   (With `EU_DEV_CLIENT_ID` set, leave out `--client-id`.)

   It writes `.local/auth.env` (git-ignored) and runs `docker compose up -d`,
   which seeds the link and restarts the server with `AUTH_PROVIDER=oidc`,
   `OIDC_ISSUER=https://auth.test.weldsuite.eu`, the project as
   `OIDC_AUDIENCE` and its roles claim as `OIDC_ORG_CLAIM` (all read from
   https://app.test.weldsuite.eu/config.json), and the client id as
   `OIDC_WEB_CLIENT_ID`. In more than one EU test workspace? It lists them:
   run it again with `--org <id>`. Without a token, pass `--user <your
   Zitadel user id> --org <organization id> --email <address>`.

3. **The platform**, from the repo root:

   ```bash
   pnpm --filter platform dev:eu --backend http://localhost:8080
   ```

   `dev:eu` (`apps/web/platform/scripts/dev-eu.mjs`) copies this server's
   `/config.json` (its modules, its features, the sign-in settings above) to
   `apps/web/platform/public/config.json` (git-ignored), adds `apiBaseUrl`
   `http://localhost:8080` because the dev server is on another origin, and
   starts Vite on http://localhost:3000 with `VITE_RUNTIME_CONFIG=on`. Open
   it and sign in with your EU test account: you land in "Local workspace",
   and every API call goes to the server here. The server allows
   http://localhost:3000 (CORS, `rust/catalogs/first-party-origins.json`).
   Without the dev server, http://localhost:8080 serves the platform the
   image was built with, already wired to this server.

**Back to the minted tokens:** `node eu-test-auth.mjs --off` deletes
`.local/auth.env`, maps `ws_local` to `org_local` again and restarts the
server. Running `eu-test-auth.mjs` again (`--client-id` is remembered)
switches back.

**What EU test does that this stack doesn't:** WeldSuite's own sign-in
screens, and everything that needs EU test's Zitadel service token: creating
workspaces (onboarding), invitations and the identity sync. Signing up for an
account, a password reset and a second factor happen on EU test, on Zitadel's
pages. A workspace other than the one you linked answers errors here: switch
to "Local workspace". Other EU test users get in once you add them as members
of `ws_local` yourself (`workspace_members` in `tenant`, `user_workspaces` in
`master`, by their Zitadel user id).

## Postman

1. **Import** (File → Import) both files:
   - `weldsuite-local.postman_collection.json` (this directory): the requests,
     in folders;
   - `.local/weldsuite-local.postman_environment.json` (written by
     `mint-token.mjs`): `baseUrl` and the tokens.
2. **Select the environment** "WeldSuite local" (top right).
3. **Send** the requests in order, or run a whole folder (… → Run folder).
   Requests that create something save its id (`spaceId`, `pageId`,
   `accessRequestId`) for the ones after them, and every request checks its
   status code.

**Who you are.** The collection sends `Authorization: Bearer {{token}}`. In the
environment, `token` holds the admin's token (`user_admin`, every permission).
Set it to `{{memberToken}}` to call as the member (`user_member`, the MEMBER
role's defaults): "Approve it (admin)" then answers 403. Without a token every
`/api` route answers 401.

**Your own requests.** Pick the environment, use `{{baseUrl}}/api/...`, and
leave Authorization on "Inherit auth from parent" (inside the collection) or set
"Bearer Token" to `{{token}}`. Send JSON bodies with `Content-Type:
application/json`. Answers look like `{ "data": … }`, lists add
`pagination`, errors are `{ "error": { "code", "message" } }`.

**The tokens** are Clerk-shaped session tokens (`sub` the user, `o.id` the
organisation `org_local`, which `seed/master.sql` maps to the workspace
`ws_local`) signed with the key in `.local/keys/`. The server only accepts that
key (`CLERK_JWKS_FILE`), so they open nothing else.

**With EU test sign-in on**, the server refuses these tokens (401). Either go
back with `node eu-test-auth.mjs --off`, or call as yourself: put an EU test
access token in `token` (the snippet under "Your access token", run on
http://localhost:3000 or on EU test). It lasts as long as Zitadel's access
tokens do (12 hours by default), and the member's token has no counterpart.

## Looking inside

```bash
docker compose logs -f weldsuite                     # the server
docker compose exec postgres psql -U weldsuite -d tenant   # the workspace's data
cat .local/auth.env                                  # the sign-in eu-test-auth.mjs set up
```
