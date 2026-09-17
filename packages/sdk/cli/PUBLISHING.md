# Publishing `@weldsuite/cli` (and `@weldsuite/app-sdk`)

Public npm packages for the Weld CLI (`weld`) and the app iframe SDK. First-party
users install from the registry, not from this monorepo checkout.

## Status

| Item | Value |
| --- | --- |
| Packages | `@weldsuite/cli`, `@weldsuite/app-sdk` |
| First release version | `0.1.0` |
| Registry | https://registry.npmjs.org |
| Scope | `@weldsuite` (org already publishes `@weldsuite/helpdesk-widget-sdk`) |
| CI auth (happy path) | **Trusted Publishing** (GitHub Actions OIDC) — no `NPM_TOKEN` |
| CI auth (legacy fallback) | Optional Automation token via `secrets.NPM_TOKEN` + workflow input |
| Workflow filename | **`publish-cli.yml`** (must match npm Trusted Publisher config exactly) |

## Preferred: Trusted Publishing (OIDC)

npm discourages long-lived Automation tokens for CI/CD. Configure each package
once on npmjs.com, then the workflow publishes with a short-lived OIDC token.

### One-time clicks on npmjs.com (Gert)

Repeat for **each** package (`@weldsuite/cli` and `@weldsuite/app-sdk`):

1. Open https://www.npmjs.com/package/@weldsuite/cli (or `/package/@weldsuite/app-sdk`)  
   - If the package **does not exist yet** (404): do a **one-time** first publish
     with `npm login` from a clean checkout (Method 2 below), **or** create the
     package under the `@weldsuite` org, then continue. Trusted Publisher settings
     live on an existing package page.
2. Sign in as an **owner** (or user with settings access) on the `weldsuite` org.
3. Open **Package settings** (gear / Settings on the package page).
4. Find **Trusted Publisher** (sometimes labeled Trusted publishing).
5. **Select your publisher** → **GitHub Actions**.
6. Fill in exactly:
   - **Organization or user:** `weldsuite`
   - **Repository:** `weldsuite`
   - **Workflow filename:** `publish-cli.yml`  
     (filename only — not `.github/workflows/publish-cli.yml`)
   - **Environment name:** leave empty (this workflow does not use a GitHub Environment)
   - **Allowed actions:** allow **`npm publish`** (required for this workflow’s direct publish)
7. Save.

Do the same for `@weldsuite/app-sdk` with the **same** org/repo/workflow values.

### After Trusted Publisher is saved

1. Merge this docs/workflow PR to `develop` (if not already).
2. Actions → **Publish Weld CLI** → Run workflow:
   - version: `0.1.0` (or next semver)
   - dist-tag: `latest`
   - packages: `cli`, `app-sdk`, or `both`
   - use_legacy_npm_token: **false** (default)
3. Confirm:
   - https://www.npmjs.com/package/@weldsuite/cli
   - https://www.npmjs.com/package/@weldsuite/app-sdk
4. Optional hardening (after a successful OIDC publish): package Settings →
   **Publishing access** → require 2FA and **disallow tokens**.
5. **Delete** GitHub Actions secret `NPM_TOKEN` if it exists, and revoke any npm
   Automation tokens that were only used for this CI path. Keep interactive
   `npm login` for rare local publishes if you want; do not keep long-lived
   Automation tokens in CI.

Tag trigger (optional): push `cli-v0.1.0` — publishes **CLI only** at that version.

## Legacy fallback: Automation token

Only if Trusted Publishing is broken or you must unblock a release before the
npm.org Trusted Publisher rows exist:

1. Create a short-lived npm **Automation** (or Granular) token with publish on `@weldsuite`.
2. Add it as repo Actions secret `NPM_TOKEN` (not an Environment secret).
3. Run **Publish Weld CLI** with **use_legacy_npm_token = true**.
4. After OIDC works, revoke the token and delete the GitHub secret.

Automation tokens are **discouraged** by npm for CI/CD; treat them as emergency
only.

## Method 2: Manual from a clean checkout

Use for the **first** publish of a package that does not exist on the registry
yet (so you can open package Settings and attach a Trusted Publisher), or for
rare offline/emergency releases.

```bash
git fetch origin develop && git checkout develop && git pull
cd packages/sdk/cli   # or packages/sdk/app-sdk

# sanity (from repo root as needed)
pnpm install
pnpm run typecheck    # CLI / app-sdk scripts differ slightly
pnpm test             # CLI only
pnpm run build
npm pack --dry-run

# interactive auth — prefer this over Automation tokens
npm login

# first publish of a scoped package must be public
npm publish --access public

# verify
npm view @weldsuite/cli version
npm install -g @weldsuite/cli
weld --version
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

Scaffolded apps depend on `@weldsuite/app-sdk` from the registry — publish that
companion the same day (`packages: both` or a second workflow run).

## Version bumps

Bump `packages/sdk/cli/package.json` (and/or `packages/sdk/app-sdk/package.json`)
`version` in a PR, merge, then publish that exact version (npm versions are
immutable). Use semver:

| Change | Example |
| --- | --- |
| Features / manage commands | `0.1.0` → `0.2.0` |
| Fixes only | `0.1.0` → `0.1.1` |
| Breaking CLI flags / auth | `0.x` → `1.0.0` when ready |

## Can `NPM_TOKEN` be deleted?

**Yes**, after:

1. Trusted Publisher is configured for every package this workflow publishes, and
2. At least one successful OIDC publish (or you are confident the config matches
   `weldsuite` / `weldsuite` / `publish-cli.yml`),

then delete GitHub secret `NPM_TOKEN` and revoke the underlying npm Automation
token. The workflow default path does not read it.
