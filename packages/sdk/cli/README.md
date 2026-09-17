# @weldsuite/cli

`weld`, the CLI for building, deploying, and publishing **WeldSuite apps**: separate Vite frontends that run inside the WeldSuite platform in a sandboxed iframe, with per-app storage and scoped access to the WeldSuite App API (`https://api.weldsuite.org/v1`).

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
| `WELD_API_KEY` | for API commands | Workspace API key (`wsk_…`). Create one in WeldSuite under **Settings → API keys**. |
| `WELD_API_URL` | no | API base URL. Default: `https://api.weldsuite.org`. |
| `WELD_DEV_USER_ID` | with workspace keys | Clerk user id that should see `weld app dev` previews. Personal API keys infer this. |

```bash
export WELD_API_KEY=wsk_...
```

## Commands

```text
weld app init [dir] [--name <name>] [--code <code>] [--force]
weld app create [dir] [--name <name>] [--code <code>] [--force]
weld app dev [--port <n>] [--tunnel] [--user-id <id>]
weld app deploy [--dir <dist>] [--changelog <text>] [--skip-build]
weld app publish [--notes <text>]
weld app list
weld skill install [--force]
weld --help | --version
```

- **`app init`**, scaffolds a Vite + React app wired to `@weldsuite/app-sdk`.
- **`app create`**, scaffolds if `weldapp.json` is missing, then registers the app (`POST /v1/user-apps`).
- **`app dev`**, starts Vite and registers a per-user preview URL so `/apps/{code}` iframes your local server. Other members still see the published bundle. Use `--tunnel` (cloudflared) against the hosted HTTPS platform.
- **`app deploy`**, validates the manifest, builds, and uploads `dist/**`.
- **`app publish`**, submits the app for public app-store review (first-party publisher workspaces auto-approve).
- **`app list`**, table of your apps.
- **`skill install`**, drops the `weldsuite-app` skill + CLAUDE.md snippet into `.claude/`.

## The agent-first workflow

```bash
export WELD_API_KEY=wsk_...
weld app create expense-notes --name "Expense Notes" --code expense-notes
cd expense-notes && npm install
weld app dev                 # or: weld app dev --tunnel
# ship
# bump version in weldapp.json
weld app deploy --changelog "First release"
weld app publish --notes "Initial review"   # optional
```

## Errors

API errors are rendered from the platform's `{ error: { code, message } }` envelope, and a missing `WELD_API_KEY` prints setup instructions instead of a stack trace.

## Related

- [`@weldsuite/app-sdk`](https://www.npmjs.com/package/@weldsuite/app-sdk), the runtime SDK (bridge + API client + React bindings) used by scaffolded apps.

## License

MIT
