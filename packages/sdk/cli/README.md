# @weldsuite/cli

`weld`, the CLI for building, deploying, and publishing **WeldSuite apps**: small web apps that run inside the WeldSuite platform in a sandboxed iframe, with per-app storage and scoped access to the WeldSuite API.

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

```bash
export WELD_API_KEY=wsk_...
```

## Commands

```text
weld app init [dir] [--name <name>] [--code <code>] [--force]
weld app create
weld app deploy [--dir <dist>] [--changelog <text>] [--skip-build]
weld app publish [--notes <text>]
weld app list
weld skill install [--force]
weld --help | --version
```

- **`app init`**, scaffolds a Vite + React app wired to `@weldsuite/app-sdk`: a working storage-CRUD demo, theme awareness, a `weldapp.json` manifest, plus `CLAUDE.md` and the `weldsuite-app` Claude skill so an agent can take it from there. Prompts for name/code if not passed as flags.
- **`app create`**, registers the app from `weldapp.json` in your workspace (one-time, `POST /v1/user-apps`).
- **`app deploy`**, validates the manifest (same Zod schema as the server), runs your project's build (`pnpm`/`yarn`/`npm` auto-detected from the lockfile), and uploads `dist/**` as a new version with the manifest. Prints file count, size, and the resulting version/status.
- **`app publish`**, submits the app for public app-store review.
- **`app list`**, table of your apps: code, name, visibility, review status, installs.
- **`skill install`**, drops the `weldsuite-app` skill and a `CLAUDE.md` snippet into the current directory's `.claude/`. Idempotent; refuses to clobber locally modified files without `--force`.

## The agent-first workflow

The scaffold is built so Claude (or any coding agent) can do the actual app development:

```bash
# 1. Scaffold
weld app init expense-notes --name "Expense Notes" --code expense-notes
cd expense-notes && npm install

# 2. Register it in your workspace (once)
export WELD_API_KEY=wsk_...
weld app create

# 3. Have Claude build the app
claude   # CLAUDE.md + .claude/skills/weldsuite-app/ give it the manifest schema,
         # bridge lifecycle, storage API, scopes, and a Definition of Done

# 4. Ship a version (bump "version" in weldapp.json first)
weld app deploy --changelog "First release"

# 5. Optional: submit to the public app store
weld app publish --notes "Initial review"
```

Working on WeldSuite apps from an existing repo? `weld skill install` adds the same agent guidance there.

## Errors

API errors are rendered from the platform's `{ error: { code, message } }` envelope, and a missing `WELD_API_KEY` prints setup instructions instead of a stack trace.

## Related

- [`@weldsuite/app-sdk`](https://www.npmjs.com/package/@weldsuite/app-sdk), the runtime SDK (bridge + API client + React bindings) used by scaffolded apps.

## License

MIT
