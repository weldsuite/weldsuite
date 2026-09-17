---
title: Build a WeldSuite app
nextjs:
  metadata:
    title: Build a WeldSuite app
    description: Scaffold, preview, and deploy a WeldApp that runs inside WeldSuite.
---

Build a small web app that WeldSuite hosts and opens at `/apps/{code}` — entirely from the CLI. {% .lead %}

WeldApps are separate Vite frontends. The platform loads them in a sandboxed iframe and gives them a scoped token for the **WeldSuite App API** (`https://api.weldsuite.org/v1`). They do not receive a Clerk session or first-party `/api/*` access. The optional developer portal mirrors the same manage flows; you do not need it to ship.

---

## Create the app

1. Install the CLI (`Node 20+`):

   ```bash
   npm install -g @weldsuite/cli
   weld login                    # interactive; or for CI: export WELD_API_KEY=wsk_...
   ```

2. Scaffold and register in one step:

   ```bash
   weld app create expense-notes --name "Expense Notes" --code expense-notes
   cd expense-notes && npm install
   weld app list
   weld app info
   ```

   `weld app init` only writes files. `weld app create` scaffolds if needed, then calls `POST /v1/user-apps`.

3. Open **App Store → Custom apps** (or **My apps**) and install the app in your workspace so `/apps/expense-notes` appears.

---

## Preview locally

### Bare localhost (no platform host)

The scaffold opts into SDK **local preview** in Vite DEV. Start Vite and open the URL in a normal tab:

```bash
npm run dev
# open http://localhost:5173/
```

You get a mock user, in-memory app storage, and a banner (“Local preview — not connected to WeldSuite”). Real CRM/people API calls need the platform path below. Opt-in alternatives: `?weldLocal=1`, or `createWeldApp({ localDev: true })`.

### Inside WeldSuite (`weld app dev`)

```bash
weld app dev
```

This starts Vite and registers a **per-user** preview URL. Open `/apps/{code}` in WeldSuite: you see a **Development** banner and hot reload. Other members still get the published bundle.

- Platform on `localhost:3000` → no tunnel.
- Hosted platform (`https://app-test.weldsuite.org`) cannot iframe `http://localhost`. Re-run with `weld app dev --tunnel` (Cloudflare quick tunnel).
- Workspace API keys have no user: pass `--user-id` or `WELD_DEV_USER_ID` (your Clerk user id).

---

## Deploy and sidenav

1. Bump `version` in `weldapp.json` (semver).
2. `weld app deploy` builds `dist/` and uploads it.
3. `weld app versions` lists what you uploaded.
4. Install (or re-open) the app — the sidenav routes to `/apps/{code}` and loads the R2 bundle.

Manage without the portal:

- `weld app update` — sync store listing fields from `weldapp.json`
- `weld app oauth --create` — server-to-server OAuth client (secret shown once)
- `weld app publish` — public listing / review (sets visibility public)
- `weld app delete --yes` — soft-delete when no other workspace still installs it

First-party publisher workspaces skip review on publish and show an **Official** badge.

Declare API access in `weldapp.json` (`scopes`, `collections`, optional `websiteUrl` / `privacyUrl` / `screenshots` / `webhookUrl`). The scaffold includes a `/v1/people` example behind `people:read`.

---

## Next steps

- [Install apps](/getting-started/install-apps) — how workspace members add apps from the store
- CLI reference: [`@weldsuite/cli`](https://www.npmjs.com/package/@weldsuite/cli)
