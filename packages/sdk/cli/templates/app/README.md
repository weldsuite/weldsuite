# {{APP_NAME}}

A [WeldSuite](https://weldsuite.org) app scaffolded with `weld app init`. It runs inside the WeldSuite platform in a sandboxed iframe and uses [`@weldsuite/app-sdk`](https://www.npmjs.com/package/@weldsuite/app-sdk) for the host bridge and workspace-scoped API access (the WeldSuite App API at `https://api.weldsuite.org/v1`).

## Project layout

- `weldapp.json`, the app manifest (code, name, version, scopes, storage collections). Validated on every deploy.
- `src/App.tsx`, the app UI. The scaffold demonstrates storage CRUD, a `/v1/people` call, and theme awareness.
- `CLAUDE.md` + `.claude/skills/weldsuite-app/`, guidance for Claude Code so an agent can build features in this app unassisted.

## Commands

```bash
npm install          # install dependencies

export WELD_API_KEY=wsk_...   # workspace API key (Settings → API keys)
# or: weld login
weld app create      # register (scaffolds too if weldapp.json is missing)
weld app info        # metadata / visibility / review
npm run dev          # bare tab (SDK localDev — no chrome)
weld app dev         # local shell + Vite (opens browser); --tunnel for hosted platform
weld app deploy      # build + upload a new version (uses weldapp.json's version)
weld app versions    # list uploaded versions
weld app update      # sync metadata from weldapp.json
weld app oauth --create  # optional server-to-server credentials
weld app publish     # optional: submit to the public app store
```

The developer portal is optional — this CLI covers create → deploy → publish → manage.

## CI/CD (GitHub Actions)

This scaffold includes [`.github/workflows/deploy-weld-app.yml`](.github/workflows/deploy-weld-app.yml).

1. Push the app to your own GitHub repository.
2. Add repo secret **`WELD_API_KEY`** — a `wsk_…` key with scope `user-apps:manage` (WeldSuite **Settings → API keys**). `weld login` is interactive-only and cannot run in CI.
3. Optionally set Actions variable **`WELD_API_URL`** to `https://api-test.weldsuite.org` for the test API (default is production `https://api.weldsuite.org`).
4. Bump `version` in `weldapp.json` (semver) before each deploy commit — reusing a version fails.
5. Push to `main`/`master` (or run **Actions → Deploy WeldApp → Run workflow**). The workflow builds and runs `weld app deploy`.

Use **`weld app publish`** (or the workflow’s `publish` input on `workflow_dispatch`) only when you want public App Store review — not on every push.

Other CI systems: export the same env vars, install Node 20 + `@weldsuite/cli`, then `weld app deploy`.

## Notes

- **Bare local preview:** `npm run dev` and open `http://localhost:5173/`. The scaffold opts into SDK `localDev` in Vite DEV (mock host + in-memory storage + banner).
- **Local shell:** `weld app dev` opens a WeldSuite-like shell (`http://localhost:4173/`) with sidebar chrome and the real postMessage bridge (in-memory storage). Also registers `/apps/{code}` for the real platform (`--tunnel` when hosted).
- Bump `version` in `weldapp.json` before each deploy.
- Declare every storage collection you use under `collections` in `weldapp.json`.
- Any WeldSuite API beyond app storage requires the matching entry in `scopes` (e.g. `people:read`), consented by the workspace admin on install.
- Optional listing fields: `websiteUrl`, `privacyUrl`, `screenshots`, `webhookUrl` (receives `app.installed` / `app.uninstalled`).
