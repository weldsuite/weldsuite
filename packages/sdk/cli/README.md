# @weldsuite/cli

`weld`, the CLI for building, deploying, and publishing **WeldSuite apps**: separate Vite frontends that run inside the WeldSuite platform in a sandboxed iframe, with per-app storage and scoped access to the WeldSuite App API (`https://api.weldsuite.org/v1`).

**CLI-first.** You can create, preview, ship, and manage apps without opening the developer portal. The portal at `developer.weldsuite.org` is optional for the same manage flows.

Zero-fat by design: the only runtime dependency is `zod` (for validating `weldapp.json` exactly like the server does).

## Install

```bash
npm install -g @weldsuite/cli
weld --version
```

Requires Node 20+.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `WELD_API_KEY` | for API commands | Workspace or personal API key (`wsk_…`) with `user-apps:manage`. Create one in WeldSuite under **Settings → API keys**. |
| `WELD_API_URL` | no | API base URL. Default: `https://api.weldsuite.org` (test: `https://api-test.weldsuite.org`). |
| `WELD_DEV_USER_ID` | with workspace keys | Clerk user id that should see `weld app dev` previews. Personal API keys infer this. |

```bash
export WELD_API_KEY=wsk_...
```

Auth is API-key only — there is no Clerk browser login in the CLI.

## Commands

```text
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
| `app init` | Scaffold a Vite + React app wired to `@weldsuite/app-sdk`. |
| `app create` | Scaffold if needed, then register (`POST /v1/user-apps`). |
| `app info` | Show one app's metadata, visibility, and review status. |
| `app list` | Table of your workspace apps. |
| `app update` | Patch metadata (`PATCH /v1/user-apps/:id`); default syncs from `weldapp.json`. |
| `app versions` | List uploaded versions. |
| `app dev` | Vite + per-user preview so `/apps/{code}` iframes your local server. Use `--tunnel` against hosted HTTPS. |
| `app deploy` | Validate manifest, build, upload `dist/**`. |
| `app publish` | Submit for public store review (sets visibility `public`). Official publishers auto-approve. |
| `app oauth` | Create / rotate / show the OAuth client for server-to-server calls. |
| `app delete` | Soft-delete the app (refused while other workspaces still install it). |
| `skill install` | Drop the `weldsuite-app` skill + CLAUDE.md snippet into `.claude/`. |

## Portal-free happy path

```bash
export WELD_API_KEY=wsk_...
# optional for test: export WELD_API_URL=https://api-test.weldsuite.org

weld app create expense-notes --name "Expense Notes" --code expense-notes
cd expense-notes && npm install

weld app list
weld app info

weld app dev                 # or: weld app dev --tunnel
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

API errors are rendered from the platform's `{ error: { code, message } }` envelope, and a missing `WELD_API_KEY` prints setup instructions instead of a stack trace.

## Related

- [`@weldsuite/app-sdk`](https://www.npmjs.com/package/@weldsuite/app-sdk) — runtime SDK (bridge + API client + React bindings).
- Optional portal: `https://developer.weldsuite.org` (same manage features via Clerk).

## License

MIT
