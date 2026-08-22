---
name: help-docs
description: >-
  Keep help.weldsuite.com in sync with platform UI. Use when changing WeldHost
  (or other documented) UI, editing apps/web/docs guides, or when the user asks
  to update help screenshots or product documentation images.
---

# Help docs + UI screenshots

See [.agents/skills/help-docs/SKILL.md](../../.agents/skills/help-docs/SKILL.md) for the full workflow.

Quick command after UI changes:

```bash
pnpm --filter docs capture-screenshots:all
```

Commit updated PNGs under `apps/web/docs/public/images/help/` with the UI change.
