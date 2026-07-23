# design-sync notes, @weldsuite/ui (WeldSuite UI)

Repo-specific gotchas for syncing `@weldsuite/ui` to claude.ai/design. Read before any re-sync.

## Build setup

- **Shape: storybook.** The Storybook lives at `apps/tools/storybook/.storybook` (monorepo app `storybook`), aliasing `@weldsuite/ui` → `packages/design/ui/src`. It is the fidelity oracle.
- **`@weldsuite/ui` has NO build and NO dist.** It ships TS source directly via subpath exports (`./components/*.tsx`), with no `.` barrel. The storybook shape needs a real `--entry`, so we **synthesize a barrel**: `node .design-sync/gen-barrel.mjs` scans the stories for every `@weldsuite/ui/<sub>` import and writes `packages/design/ui/.ds-entry.ts` (gitignored). It MUST live inside `packages/design/ui` so the converter's PKG_DIR walk-up lands on `packages/design/ui/package.json` (the repo root package, named `weldsuite`, would otherwise capture PKG_DIR).
- **`cfg.tsconfig: "tsconfig.json"`** (packages/ui-relative) lets esbuild resolve the `@weldsuite/ui/* → ./src/*` path alias used inside components.
- **`--node-modules` = repo root `node_modules`.** `packages/design/ui/node_modules` has no `react`; everything (react, jotai, next, @uidotdev/usehooks, lodash.throttle, @dnd-kit/modifiers) is hoisted to the root store. Build runs with root node_modules.
- **Reference storybook OOMs at the default heap.** `npx storybook build` silently exits 0 mid-`transforming…` with no `iframe.html` unless run with `NODE_OPTIONS=--max-old-space-size=8192` (118 components + recharts/embla/dnd-kit is heavy). The `buildCmd` sets this. Always check `.design-sync/sb-reference/iframe.html` exists and is >10KB after a reference build, `index.json` alone can exist with a failed preview build.

## Scope

- The barrel (and therefore `window.WeldSuiteUI`) is scoped to the **~76 story-imported modules**, not all 118 component files. App-coupled shell components (`app-sidebar-layout`, `settings-command`, `settings-dialog-full`, anything importing `@/…` app aliases like `@/contexts/workspace-context`) are deliberately excluded, they are not reusable DS primitives and their app-internal imports don't resolve. To widen the global later, extend the barrel, but those `@/`-importers will need shims/externals.

## GRADING, read raw PNGs, not sheet thumbnails (CRITICAL)

- The compare sheet (`_screenshots/compare/<group>__<Name>.png`) scales the two panels INDEPENDENTLY: the **storybook** side is a tight crop (e.g. a Button is ~108×68px) while the **preview** side is a full ~900×700 page with the component top-left in lots of whitespace. The sheet shrinks the 900px preview to the column width, so the component LOOKS ~half-size next to the tight-cropped storybook. **This is a pure framing artifact, components render at correct natural size.** Confirmed in the solo gate: Button/Avatar at full-res raw match storybook exactly.
- **Always judge from `_screenshots/compare/raw/<…>__sb.png` vs `…__ds.png`** (full-res). The `__ds` raw is a 900×700 page, find the component top-left. Never grade "too small / mismatch" off the sheet thumbnail alone.
- Egress works: the Avatar `With Image` story loads `github.com/shadcn.png` on both panels, no `[ASSETS_BLOCKED]`.
- **Width-flexible layouts** (`max-w-*` wrappers, `justify-between` rows, full-width tables, AuditTimeline Loading, EntityInfoCard, EntitySectionCard, Table) render spread across the full ~900px preview page while the storybook canvas shrinks to content (skeleton flex-1 lines collapse to ~0; values right-align with a gap). Pure container-width framing artifact between the two harnesses, NOT a defect, NOT per-component fixable. Judge composition/styling, not horizontal spread.
- **Overlay components render their CLOSED trigger** in the storybook reference (Dialog, ConfirmDialog, Popover, Tooltip, Sheet, Drawer, InfoPopover, InfoTooltip, Toaster, DropdownMenu, ContextMenu, HoverCard, Command, AlertDialog), the overlay/panel opens only on interaction, so it never appears in the static capture. The closed trigger IS the ground-truth reference; previews matching the trigger are correct, and **no `cardMode:"single"` override is needed** for these. (Only EntityDetailView/EntitySheetShell needed `single`, they render fixed/fullscreen content, not a trigger.)
- **InputOTP** is a "reference-is-artifact" case: storybook renders nothing for input-otp statically (sb-error, both stories). Our card renders the real component correctly (6+4 OTP slots with separator, validate-confirmed). Graded `match` on own render. A future re-sync's compare will re-flag it sb-error/needs-grade, re-confirm from the validate screenshot (`_screenshots/form__InputOTP.png`), don't chase the blank storybook side.

## CSS / fonts

- Tailwind v4 (`@import "tailwindcss"`) with oklch design tokens defined in `packages/design/ui/src/styles/globals.css`. The source CSS does NOT compile standalone (needs the build to emit utilities), so rely on the converter's `[CSS_FROM_STORYBOOK]` scrape of the compiled CSS from `sb-reference`, do NOT set `cfg.cssEntry` to the source globals.css.
- The storybook ships `nunito-sans-*.woff2` fonts in the reference build. Watch validate for `[FONT_MISSING]` on Nunito Sans and wire via `cfg.extraFonts` / preview-head harvest if it fires.

## Verify-loop findings (first sync)

- **Decorator bundle fails** (`Could not resolve "tailwindcss"`), BENIGN. The only `.storybook/preview` decorator is `withThemeByClassName` (Light=""/Dark="dark" class toggle), not a React context provider. Previews render Light (default), matching the reference. No `cfg.provider` needed.
- **`[TOKENS_MISSING]`** (11 vars: `--radix-*`, `--sidebar-width`, `--skeleton-width`, `--transform-origin`, `--available-*`), BENIGN runtime vars set by radix/sidebar/skeleton at runtime. Not missing tokens.
- **`cfg.overrides` cardMode**, 13 components flagged `[GRID_OVERFLOW]`: 11 `wide`→`column` (AspectRatio, Calendar, Carousel, KanbanBoard, ListToolbar, WorkflowList, Autocomplete, ChatInput, Accordion, Card, ScrollArea) and 2 `escape`→`single` (EntityDetailView=FullscreenMode, EntitySheetShell=Default). Presentation-only; grades carry.
- **WeldAgentIcon**, `[RENDER_THIN]`: the generated preview paints nothing (bare SVG icon). Needs an authored `.design-sync/previews/WeldAgentIcon.tsx` with sizing/color, or accept as a known thin card.
- Solo gate (Button, Avatar, Dialog, ListTable): all **match**, see grades in `.cache/compare/`.

## Known render warns (triaged, non-blocking, do NOT chase on re-sync)

- `[RENDER_THIN] WeldAgentIcon`, FALSE POSITIVE. WeldAgentIcon is an icon-only component (no text); the heuristic flags "no text + small paint". It renders correctly (black mascot icon for Default, 3 violet sizes for Sizes, verified from `_screenshots/data-display__WeldAgentIcon.png`). Graded match. No owned preview needed.
- `[TOKENS_MISSING]` (11 vars), BENIGN runtime vars (`--radix-*`, `--sidebar-width`, `--skeleton-width`, `--transform-origin`, `--available-*`) set by radix/sidebar/skeleton at runtime, not missing tokens.
- `[DTS_STYLE_SYSTEM]`, informational; @types/react CSS-shorthand props filtered from some `<Name>Props`. Not real API.
- Final `package-validate.mjs` exits **0** with these 2 non-blocking warnings; real `.d.ts` (no `[DTS_STUBBED]`); 74/74 render clean.

## Re-sync risks

- **Bundle entry is a SYNTHESIZED barrel** (`packages/design/ui/.ds-entry.ts` + `packages/design/ui/index.d.ts`, both gitignored, regenerated by `gen-barrel.mjs` from story imports). If new components get stories, re-run gen-barrel (buildCmd does). If a story imports a NEW `@weldsuite/ui/components/X` that pulls an unbundleable dep (next/jotai/@/-alias) or a stray `.css`, the build may break or the CSS scrape may suppress, see the EXCLUDE set in gen-barrel (currently workflow-canvas).
- **CSS is a COPY of the compiled storybook output** (`packages/design/ui/.ds-styles.css` ← largest `sb-reference/assets/preview-*.css`, via `cp-sb-css.mjs`). It's only as current as the last reference-storybook build. Always rebuild sb-reference (with the 8GB heap) before re-syncing, or the tokens/utilities go stale. The scrape via iframe.html `<link>` does NOT work here (Vite injects CSS via JS), `cfg.cssEntry` is mandatory.
- **WorkflowCanvas is intentionally EXCLUDED** (not synced): xyflow CSS suppresses the scrape + Windows dir-read fails its preview. To add it back, resolve both and remove from gen-barrel EXCLUDE + titleMap.
- **DatePicker** ships an OWNED preview (`.design-sync/previews/DatePicker.tsx`), the trigger is `w-full` and the story uses `layout:centered`; the owned preview wraps it in `inline-flex` so it collapses to content width. If date-picker.tsx's trigger width changes upstream, re-check this.
- **InputOTP** graded on own-render (storybook ref degenerate), see GRADING section.
- Grading was done from the §4 sampling rule (primary image-judged + sibling-trusted) plus full reads for overlays/owned/warned components. `[STORY_CAP]` hit Button (6/14), Autocomplete & ChatInput (6/8), tail stories ride verified-by-upload trust; raise `--max-stories` if those tails carry distinct variants worth verifying.
- Build assumes: Node 20+/22, pnpm workspace installed at repo root, chromium via playwright 1.61.1 (chromium-1228), `NODE_OPTIONS=--max-old-space-size=8192` for the storybook build.
