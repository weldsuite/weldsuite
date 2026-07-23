<!-- weldsuite-app-skill -->
# WeldSuite app development

This project contains (or works on) a **WeldSuite app**, a static web bundle rendered by the WeldSuite platform in a sandboxed iframe, using `@weldsuite/app-sdk` for the host bridge and workspace-scoped API access.

When working on WeldSuite app code (the `weldapp.json` manifest, `@weldsuite/app-sdk` usage, app storage collections/KV, or `weld` CLI deploys), load the `weldsuite-app` skill at `.claude/skills/weldsuite-app/SKILL.md` first, it documents the manifest schema, bridge lifecycle, storage endpoints, scopes, CLI commands, and the Definition of Done.

Quick rules:

- Bump `version` in `weldapp.json` (semver) before every `weld app deploy`.
- Declare every storage collection you use in `weldapp.json` → `collections`; declare the narrowest `scopes` for any non-storage API call.
- Record `update()` replaces the whole document, always send every field.
- Never handle tokens manually; all API access goes through the SDK.
