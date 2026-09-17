# Publishing `@weldsuite/cli`

Public npm package for the Weld CLI (`weld`). First-party users install from the
registry, not from this monorepo checkout.

## Status

| Item | Value |
| --- | --- |
| Package | `@weldsuite/cli` |
| First release version | `0.1.0` |
| Registry | https://registry.npmjs.org |
| Scope | `@weldsuite` (org already publishes `@weldsuite/helpdesk-widget-sdk`) |
| GitHub secret | `NPM_TOKEN` (repo-level Automation token with publish rights on `@weldsuite`) |

## Prerequisites

1. You are an **owner** or **publisher** on the npm `weldsuite` org.
2. An Automation (or Granular) access token that can publish `@weldsuite/*` is
   available as:
   - local: `NPM_TOKEN` / `NODE_AUTH_TOKEN`, or `npm login`
   - CI: GitHub Actions secret `NPM_TOKEN` (Settings → Secrets and variables → Actions)
3. Optional but recommended: also publish `@weldsuite/app-sdk@0.1.0` the same
   day. Scaffolded apps depend on it (`npm install` after `weld app create`).
   That package is **not** on the registry yet (same gap as the CLI was).

## Method 1: GitHub Actions (recommended)

1. Add repo secret `NPM_TOKEN` (npm Automation token, read+write for `@weldsuite`).
2. Merge the release-prep PR to `develop` (or `main` if you prefer tagging from there).
3. Actions → **Publish Weld CLI** → Run workflow:
   - version: `0.1.0` (or next semver)
   - dist-tag: `latest`
4. Confirm: https://www.npmjs.com/package/@weldsuite/cli

Tag trigger (optional): push `cli-v0.1.0` and the same workflow publishes that version.

## Method 2: Manual from a clean checkout

```bash
git fetch origin develop && git checkout develop && git pull
cd packages/sdk/cli

# sanity
pnpm install   # from repo root if needed
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run   # expect dist/, templates/, README, LICENSE — no *.test.js

# auth (pick one)
npm login
# or: export NODE_AUTH_TOKEN=<npm_automation_token>

# first publish of a scoped package must be public
npm publish --access public

# verify
npm view @weldsuite/cli version
npm install -g @weldsuite/cli
weld --version   # → 0.1.0
```

## After publish — install for production

```bash
npm install -g @weldsuite/cli
# or
npx @weldsuite/cli --help
```

Then:

```bash
weld login
weld app create my-app --name "My App" --code my-app
```

## Version bumps

Bump `packages/sdk/cli/package.json` `version` in a PR, merge, then publish that
exact version (npm versions are immutable). Use semver:

| Change | Example |
| --- | --- |
| Features / manage commands | `0.1.0` → `0.2.0` |
| Fixes only | `0.1.0` → `0.1.1` |
| Breaking CLI flags / auth | `0.x` → `1.0.0` when ready |

## Companion package

`@weldsuite/app-sdk` should be published with the same org token before asking
external developers to run the scaffold happy path. Until then, monorepo
`workspace:*` / path installs still work for first-party hosted apps.
