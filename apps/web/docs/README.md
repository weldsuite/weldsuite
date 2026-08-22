# WeldSuite Help (`docs`)

Public product help site for WeldSuite setup guides. Intended production host: **https://help.weldsuite.com**.

Built with Next.js + Markdoc (Tailwind Plus Syntax template).

## Local development

```bash
pnpm --filter docs dev
```

App runs on [http://localhost:3010](http://localhost:3010).

## UI screenshots

Guide images are **real screenshots** of WeldHost UI captured from preview routes — see [`.agents/skills/help-docs/SKILL.md`](../../.agents/skills/help-docs/SKILL.md).

Regenerate after UI changes:

```bash
pnpm --filter docs capture-screenshots:all
```

Agents: when you change documented UI, run the command above and commit the PNGs in the same change (`AGENTS.md`).

First-time Playwright setup:

```bash
cd apps/web/docs && pnpm exec playwright install chromium
```
