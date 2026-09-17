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
weld app dev         # live preview in /apps/{code} (add --tunnel for the hosted platform)
weld app deploy      # build + upload a new version (uses weldapp.json's version)
weld app publish     # optional: submit to the public app store
```

## Notes

- Bump `version` in `weldapp.json` before each deploy.
- Declare every storage collection you use under `collections` in `weldapp.json`.
- Any WeldSuite API beyond app storage requires the matching entry in `scopes` (e.g. `people:read`), consented by the workspace admin on install.
- Optional listing fields: `websiteUrl`, `privacyUrl`, `screenshots`, `webhookUrl` (receives `app.installed` / `app.uninstalled`).
