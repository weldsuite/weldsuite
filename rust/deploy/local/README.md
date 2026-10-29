# The Rust backend on your machine

The release image of the Rust backend with everything it talks to, in Docker
Compose: Postgres (migrated by `weldsuite migrate`, with one seeded workspace),
Valkey, NATS JetStream, S3 (RustFS), Restate and Mailpit. For calling the API
by hand (Postman) without a cluster. Every credential here is a throwaway for
this machine.

| | |
|---|---|
| API (and the platform SPA) | http://localhost:8080 |
| Mailpit (system emails) | http://localhost:8025 |
| Sign portal | http://localhost:3010 |
| Postgres | `localhost:55433`, user `weldsuite`, password `weldsuite`, databases `master` and `tenant` |

What the API serves is what this branch marks as ported
(`RUST_PORTED_MODULES`, listed in `/config.json` as `modules`): the core routes
(`/api/me/permissions`, `/api/feature-flags`, `/api/access-requests`) and
WeldKnow (`/api/knowledge/*`). The other core areas and WeldSign are ported but
only mounted in conformance builds until they are marked; they show up here
after the integration branch with the edition flags is merged.

## Start

Needs Docker and Node. From this directory:

```bash
node mint-token.mjs              # once: the session key, and tokens valid 30 days
docker compose up -d             # migrates, seeds, then starts the server
curl http://localhost:8080/readyz
```

`mint-token.mjs` again makes new tokens with the same key (`node mint-token.mjs 90`
for 90 days); the server needs no restart.

**The images.** `docker compose` runs `weldsuite:local` and
`weldsuite-sign-portal:local`. Build them from the repo root of a checkout with
LF line endings (`git -c core.autocrlf=false worktree add <dir> deploy/eu-test`
on Windows):

```bash
docker build -f rust/Dockerfile -t weldsuite:local .
docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:local .
```

Or use what the "Rust images" workflow pushed, once the packages are public:
`WELDSUITE_IMAGE=ghcr.io/weldsuite/weldsuite:sha-… PORTAL_IMAGE=ghcr.io/weldsuite/weldsuite-sign-portal:sha-… docker compose up -d`.

**Stop:** `docker compose down` keeps the database; `docker compose down -v`
starts over.

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

## Looking inside

```bash
docker compose logs -f weldsuite                     # the server
docker compose exec postgres psql -U weldsuite -d tenant   # the workspace's data
```
