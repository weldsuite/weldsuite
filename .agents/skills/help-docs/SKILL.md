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

## Support videos

Guides can embed a screen recording of the **real** platform UI:

```markdown
{% video src="/videos/help/<name>.mp4" poster="/videos/help/<name>.jpg" title="..." caption="..." /%}
```

| Layer | Path |
| --- | --- |
| Video scripts (fixtures + steps) | `apps/web/docs/scripts/videos/<name>.mjs` |
| Registry | `apps/web/docs/scripts/videos.config.mjs` |
| Recorder (cursor, captions, 1080p H.264) | `apps/web/docs/scripts/video-director.mjs` |
| API fixtures helper | `apps/web/docs/scripts/mock-api.mjs` |
| Output | `apps/web/docs/public/videos/help/<name>.{mp4,jpg}` |
| Unauthenticated module mirror | `apps/web/platform/src/routes/preview/<module>/` + `app/preview/<module>/` |

How it works: `/preview/<module>/*` mirrors the module's real routes inside
`PreviewModeProvider` (`contexts/preview-mode-context.tsx`). There the app sees
`/<module>/...` paths, navigation stays under `/preview`, and the app-api client
sends a placeholder token instead of a Clerk session, so every API call goes
out and Playwright answers it from the video's fixtures (`mockApi`). Unmatched
calls get a 404, which shell widgets tolerate.

Record (platform dev server running):

```bash
PLATFORM_URL=http://localhost:3000 pnpm --filter docs record-videos <name>
```

Adding a video for another module:

1. Mirror the module's route files under `src/routes/preview/<module>/` (same
   components, `/preview` prefix) with a shell like
   `app/preview/weldmail/preview-weldmail-shell.tsx`.
2. Open the preview in a browser, list the `/api/*` requests it makes, and add
   fixtures for the ones the screen needs (copy shapes from
   `@weldsuite/app-api-client` domain types).
3. Script the steps with the `Director` (`caption`, `click`, `type`, `pause`),
   prefer `getByRole` / `getByTestId` / placeholders over CSS selectors, and
   give it `intro` / `outro` cards.
4. Register it in `videos.config.mjs`, record, embed, commit MP4 + poster.

Keep videos short (under a minute), one task per video, and fixture data
fictional (`*.example` / `example.com` addresses).

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
