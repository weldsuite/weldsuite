# @weldsuite/cli

`weld`, the CLI for building, deploying, and publishing **WeldSuite apps**: separate Vite frontends that run inside the WeldSuite platform in a sandboxed iframe, with per-app storage and scoped access to the WeldSuite App API (`https://api.weldsuite.org/v1`).

**CLI-first.** You can create, preview, ship, and manage apps without opening the developer portal. The portal at `developer.weldsuite.org` is optional for the same manage flows.

Zero-fat by design: the only runtime dependency is `zod` (for validating `weldapp.json` exactly like the server does).

## Install

Production (npm registry):

```bash
npm install -g @weldsuite/cli
# or one-shot:
npx @weldsuite/cli --help
weld --version
```

From this monorepo (contributors only):

```bash
pnpm --filter @weldsuite/cli build
pnpm --filter @weldsuite/cli exec weld --version
```

Requires Node 20+. The published package is `@weldsuite/cli` on the public npm registry (`latest` tag).

## Authentication

### Interactive (recommended)

```bash
weld login
```

Opens the developer portal, shows a short device code, and after you confirm + pick a workspace, stores a personal API key under `~/.config/weldsuite/credentials.json` (mode `0600`). Then:

```bash
weld whoami
weld app list
weld logout          # removes the local file (revoke “Weld CLI” in Settings if desired)
```

### CI / scripts

```bash
export WELD_API_KEY=wsk_...   # always wins over the login session
```

`weld login` is **interactive only** (browser device code). For GitHub Actions and other CI, use a dedicated `WELD_API_KEY` with scope `user-apps:manage`.

| Variable | Required | Description |
| --- | --- | --- |
| `WELD_API_KEY` | for CI | Workspace or personal API key (`wsk_…`) with `user-apps:manage`. Overrides `weld login`. |
| `WELD_API_URL` | no | External API base. Default: `https://api.weldsuite.org` (test: `https://api-test.weldsuite.org`). |
| `WELD_APP_API_URL` | no | app-api host used by `weld login`. Derived from `WELD_API_URL` when unset. |
| `WELD_LOGIN_URL` | no | Developer portal origin for the browser step. |
| `WELD_DEV_USER_ID` | with workspace keys | Clerk user id that should see `weld app dev` previews. Personal keys infer this. |

### GitHub Actions (scaffolded)

`weld app init` / `weld app create` copies `.github/workflows/deploy-weld-app.yml` into new apps. On push to `main`/`master` (or `workflow_dispatch`) it installs deps, installs `@weldsuite/cli`, and runs `weld app deploy`.

**Secrets checklist**

| Name | Where | Notes |
| --- | --- | --- |
| `WELD_API_KEY` | Actions secret | `wsk_…` with `user-apps:manage`. Create under WeldSuite **Settings → API keys**. Do not reuse an interactive `weld login` session key. |
| `WELD_API_URL` | Actions **variable** (optional) | Leave unset for production (`https://api.weldsuite.org`). Set `https://api-test.weldsuite.org` for the test stack. |

**Version bump:** edit `version` in `weldapp.json` (strict semver `x.y.z`) in the same commit you want deployed. The API rejects re-uploading an existing version.

**Deploy vs publish**

| Command | When |
| --- | --- |
| `weld app deploy` | Every release to your workspace (CI default). Uploads `dist/**` as a new version. |
| `weld app publish` | Only when you want a **public** App Store listing / review. Optional on `workflow_dispatch` (`publish: true`); do not auto-run on every push. |

**Other CI (GitLab, Circle, etc.):** set `WELD_API_KEY` (+ optional `WELD_API_URL`), install Node 20+, `npm install`, `npm install -g @weldsuite/cli`, then `weld app deploy --changelog "…"`.

## Commands

```text
weld login [--no-browser] [--api-url <url>] [--login-url <url>]
weld logout
weld whoami [--check]
weld app init [dir] [--name <name>] [--code <code>] [--force]
weld app create [dir] [--name <name>] [--code <code>] [--force]
weld app info [--code <code>]
weld app list
weld app update [--from-manifest] [--name …] [--description …] [--icon …] [--category …]
                [--website-url …] [--privacy-url …] [--webhook-url …] [--active|--inactive]
weld app versions [--code <code>]
weld app dev [--port <n>] [--tunnel] [--user-id <id>]
weld app deploy [--dir <dist>] [--changelog <text>] [--skip-build]
weld app publish [--notes <text>]
weld app oauth [--create|--rotate|--show] [--code <code>]
weld app delete [--code <code>] [--yes]
weld skill install [--force]
weld --help | --version
```

| Command | Purpose |
| --- | --- |
| `login` | Clerk browser + device-code flow; mints a personal key with `user-apps:manage`. |
| `logout` | Delete the local credentials file. |
| `whoami` | Print the active identity; `--check` pings the API. |
| `app init` | Scaffold a Vite + React app wired to `@weldsuite/app-sdk`. |
| `app create` | Scaffold if needed, then register (`POST /v1/user-apps`). |
| `app info` | Show one app's metadata, visibility, and review status. |
| `app list` | Table of your workspace apps. |
| `app update` | Patch metadata (`PATCH /v1/user-apps/:id`); default syncs from `weldapp.json`. |
| `app versions` | List uploaded versions. |
| `app dev` | Vite + per-user preview so `/apps/{code}` iframes your local server. Use `--tunnel` against hosted HTTPS. For bare localhost UI without the host, `npm run dev` + SDK `localDev`. |
| `app deploy` | Validate manifest, build, upload `dist/**`. |
| `app publish` | Submit for public store review (sets visibility `public`). Official publishers auto-approve. |
| `app oauth` | Create / rotate / show the OAuth client for server-to-server calls. |
| `app delete` | Soft-delete the app (refused while other workspaces still install it). |
| `skill install` | Drop the `weldsuite-app` skill + CLAUDE.md snippet into `.claude/`. |

## Portal-free happy path

```bash
weld login
# or for CI: export WELD_API_KEY=wsk_...
# optional for test: export WELD_API_URL=https://api-test.weldsuite.org

weld app create expense-notes --name "Expense Notes" --code expense-notes
cd expense-notes && npm install

weld app list
weld app info

npm run dev                  # local preview in a bare tab (SDK localDev)
weld app dev                 # or: weld app dev --tunnel — real host + API
# bump version in weldapp.json
weld app deploy --changelog "First release"
weld app versions

# optional manage
weld app update              # sync listing fields from weldapp.json
weld app oauth --create      # once, if your backend needs client_credentials

# optional public store
weld app publish --notes "Initial review"
```

Install the app in your workspace (**App Store → Custom apps**) so `/apps/{code}` appears, then open it on the platform.

## Errors

API errors are rendered from the platform's `{ error: { code, message } }` envelope. Missing credentials point at `weld login` (or `WELD_API_KEY` for CI) instead of a stack trace.

## Related

- [`@weldsuite/app-sdk`](https://www.npmjs.com/package/@weldsuite/app-sdk) — runtime SDK (bridge + API client + React bindings).
- Developer portal CLI auth: `https://developer.weldsuite.org/cli-auth` (opened by `weld login`).
- Optional portal manage UI: `https://developer.weldsuite.org` (same manage features via Clerk).

## License

MIT
