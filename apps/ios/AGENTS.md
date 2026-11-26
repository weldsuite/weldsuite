# Native iOS apps (`apps/ios`)

Swift and SwiftUI, iOS 17 and later. Read the root `AGENTS.md` first, and
`apps/android/AGENTS.md`: the two platforms are built in step.

- **One feature, both platforms, one PR.** A change to a screen or to the
  core lands in `apps/ios` and `apps/android` together, unless it only exists
  on one platform (an AutoFill extension, a widget).
- **API types are generated, never written by hand.** Change
  `apps/mobile-shared/openapi/<module>.yaml` (and the Rust handler it
  describes), then `pnpm mobile:generate` copies it into `WeldKit`. An app
  maps the generated types to its own models in one file (WeldPass:
  `PassStore.swift`), so a generator rename stays there.
- **Strings live in `apps/mobile-shared/strings`.** Use the generated
  accessors (`CoreStrings`, `PassStrings`), never a string literal on screen.
  `en` and `nl` both.
- **Shared code goes in `WeldKit`**: `WeldCore` has no UI, `WeldUI` no app
  logic. An app target holds its own screens and its own API calls.
- **The project is generated.** Edit `Project.swift`, never an
  `.xcodeproj`; run `tuist generate`.
- **Swift 5 language mode for now**, with `@MainActor` on everything that
  touches UI or session state.
- **Secrets stay out of state that outlives a screen**: revealed fields live
  in a view's `@State` and are dropped when the scene goes to the background.
  The pasteboard gets secrets `localOnly` with a 30-second expiry.
- **Tests**: XCTest in `WeldKit/Tests` and `Apps/<App>/Tests`. Accessibility
  identifiers double as the Maestro selectors; keep them the same as
  Android's test tags.
- You can't build iOS on Windows: push and let `Native · iOS` compile it, or
  build on the Mac.
