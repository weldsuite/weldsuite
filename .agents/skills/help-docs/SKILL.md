---
name: help-docs
description: >-
  Keep help.weldsuite.org in sync with platform UI. Use when changing WeldHost
  (or other documented) UI, editing apps/web/docs guides, or when the user asks
  to update help screenshots or product documentation images.
---

# Help docs + UI screenshots

Public help site: `apps/web/docs` → **https://help.weldsuite.org**

Guide images must be **real screenshots** of production components, not SVG mockups.

## Architecture

| Layer | Path |
| --- | --- |
| Markdoc guides | `apps/web/docs/src/app/**/*.md` |
| Screenshot manifest | `apps/web/docs/scripts/screenshots.config.mjs` |
| Capture scripts | `apps/web/docs/scripts/capture-screenshots*.mjs` |
| PNG output | `apps/web/docs/public/images/help/*.png` |
| Preview scenes | `apps/web/platform/app/preview/help-docs/` |
| Fixture data | `apps/web/platform/app/preview/help-docs/fixtures.ts` |

Preview routes render **real** platform components with stable fixture data (no auth, no API):

```
/preview/help-docs?scene=domains|dns-list|dns-add|dns-locked
```

When UI components change, preview output changes → re-capture PNGs.

## When to run (mandatory)

After **any** change that affects what help docs show, you must update docs **and** regenerate screenshots in the **same task/PR**:

**Platform UI triggers** (non-exhaustive):

- `apps/web/platform/app/weldhost/**`
- `apps/web/platform/app/preview/help-docs/**`
- Shared components used by documented screens

**Docs triggers**:

- `apps/web/docs/src/app/**` (copy, steps, new guides)
- `apps/web/docs/scripts/screenshots.config.mjs` (new image / scene)

## Workflow

### 1. Update copy (if needed)

Edit Markdoc under `apps/web/docs/src/app/`. Reference PNGs only:

```markdown
{% figure src="/images/help/dns-add-record.png" alt="..." caption="..." /%}
```

### 2. Add or adjust preview scenes (if needed)

- New screen → add scene in `help-docs-preview-client.tsx` + fixture data in `fixtures.ts`
- Register PNG in `screenshots.config.mjs`

Use `initialUiState` on shared components (e.g. `DomainDetailContent`) to open the right tab/dialog without duplicating UI.

### 3. Regenerate screenshots

One command (builds platform + docs, starts preview servers, writes PNGs):

```bash
pnpm --filter docs capture-screenshots:all
```

First run on a machine may need Playwright Chromium:

```bash
cd apps/web/docs && pnpm exec playwright install chromium
```

If servers are already running (platform `:3000`, docs `:3010`):

```bash
pnpm --filter docs capture-screenshots
```

### 4. Commit together

Always commit UI/copy changes **with** updated PNGs under `public/images/help/`. Never leave docs pointing at stale images.

## Adding a new screenshot

1. Add scene + fixtures in `app/preview/help-docs/`
2. Add entry to `screenshots.config.mjs` (`file`, `url`, `selector`, `readySelector`)
3. Reference `/images/help/<file>.png` in Markdoc
4. Run `capture-screenshots:all`
5. Commit PNG + manifest + copy

## Rules

- **Do not** hand-edit PNGs or use SVG placeholders for UI that exists in the app.
- **Do not** duplicate UI in the docs app — preview routes only.
- **Do not** rely on CI to refresh images; agents and developers regenerate locally.
- Keep fixture data stable (same domain names/records) so diffs reflect UI changes only.
- Preview chrome must include providers the real shell normally supplies:

- `SidebarProvider` (for `SidebarTrigger` in the header)
- `MobileNavProvider` (for `DrawerHost` / agent shortcut inside `ModuleContent`)

See `help-docs-preview-client.tsx`.

## Navigation / URLs

Help URLs must match app catalog links (`help.weldsuite.org/weldhost`, etc.):

- `/` — home
- `/weldhost` — overview
- `/weldhost/manage-dns-records` — DNS guide

Navigation sidebar: `apps/web/docs/src/lib/navigation.ts`
