<div align="center">

# WeldSuite

CRM, helpdesk, email, projects, commerce, accounting, meetings, and team chat in one suite, behind one login, on one shared data model.

</div>

---

## What's inside

WeldSuite is one platform built from modules that share the same customer, contact, and invoice. No per-tool data silos.

| Module | What it does |
|---|---|
| **WeldCRM** | Contacts, customers, leads, opportunities, pipelines, quotes |
| **WeldDesk** | Helpdesk, tickets, conversations, knowledge base, SLAs, AI copilot |
| **WeldMail** | Email client with AI drafting and multi-account support |
| **WeldFlow** | Projects, tasks, sprints, whiteboards, docs |
| **WeldConnect** | Workspace workflow automation, integrations, and connectors |
| **WeldCommerce** | Products, orders, discounts, and a website builder |
| **WeldBooks** | Double-entry accounting with multi-jurisdiction tax support |
| **WeldStash** | Warehouse management (inventory, pick lists, cycle counts) |
| **WeldHost** | Domain registration, DNS, email forwarding |
| **WeldMeet** | Video meetings and scheduling |
| **WeldChat** | Slack-style internal team chat |
| **WeldAgent** | AI assistants wired into every module |
| **WeldApps** | User-built apps hosted in a sandbox and distributed via an app store |

## Tech stack

- **Frontend (platform):** Vite + React 19 SPA, TanStack Router (file-based), Clerk auth, Tailwind v4, shadcn/ui
- **Other frontends:** Next.js (customer sites, help center, portals), Expo / React Native (mobile apps)
- **Backend:** Hono on Cloudflare Workers
- **Database:** Neon Postgres (multi-tenant), Drizzle ORM
- **Infra:** Cloudflare (Workers, KV, R2, Queues, Durable Objects, Hyperdrive)
- **Tooling:** pnpm 10.34.5 + Turborepo, Node 20+

## Repository layout

```
apps/
  web/        Browser frontends: platform (main SPA), sites, help center, admin, portals
  workers/    Cloudflare Workers: app-api (the unified backend) + specialized workers
  mobile/     Expo / React Native apps
  tools/      Dev & ops tooling (migrations, storybook, dashboards)
  desktop/    Desktop shell
packages/
  core/       db, permissions, i18n, ai, realtime, credits, and other primitives
  clients/    Typed API clients + shared Zod schemas
  design/     Shared UI component libraries
  sdk/        Published, permissively-licensed SDKs (app-sdk, cli, widget-sdk)
  config/     Shared eslint / typescript configs
```

The unified first-party backend is `apps/workers/app-api`. Every endpoint lives there.

## Configuration & deployment

`develop` deploys to **test** (`app-test.weldsuite.org`). `main` deploys to **production** (`app.weldsuite.org`). The pipeline lives in this repository (`.github/workflows/deploy.yml`) and runs on GitHub-hosted runners. Secrets live on the GitHub Environments `test` and `production` — see [`.github/SECRETS.md`](./.github/SECRETS.md).

Hosted WeldSuite at [weldsuite.org](https://weldsuite.org) is the supported product. The AGPL source is public so you can audit, contribute, and self-host; self-hosting is not a supported product offering.

## License

WeldSuite is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](./LICENSE).

The published SDKs under `packages/sdk/` (`@weldsuite/app-sdk`, `@weldsuite/cli`, `@weldsuite/helpdesk-widget-sdk`) use permissive licenses (MIT / Apache-2.0) so you can embed them in your own apps without AGPL obligations. Each SDK package declares its own license.

The **WeldSuite name and logo are trademarks** and are *not* covered by the AGPL. See [TRADEMARK.md](./TRADEMARK.md). Forks must rebrand.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), which covers dev setup, the pull-request flow, and the Contributor License Agreement (CLA) that every contributor signs. We accept PRs but don't guarantee response times, so please be patient. By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? **Please don't open a public issue.** See [SECURITY.md](./SECURITY.md) for how to report it privately.

Copyright © 2026 WeldReach B.V.
