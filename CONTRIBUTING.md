# Contributing to WeldSuite

This guide is for members of the [weldsuite](https://github.com/weldsuite) GitHub organization. It covers how to get set up, how we work, and what we expect in a pull request.

> **Outside contributions are not accepted.** Pull requests and issues on this repository can only be opened by people with write access, i.e. members of the organization. The source is public so you can audit and self-host it. To report a vulnerability, see [SECURITY.md](./SECURITY.md).

Every PR targets **`main`**, the only branch. A merge that passes CI deploys to test; production goes out only through the Promote workflow in the private repo `weldsuite/weldsuite-deploy`.

## Before you start

- **Sign the CLA.** All contributors must agree to our [Contributor License Agreement](./CLA.md). The first time you open a pull request, an automated bot will ask you to sign; it's a one-time, quick step.
- **Read the [Code of Conduct](./CODE_OF_CONDUCT.md).** By participating you agree to uphold it.
- **For anything non-trivial, open an issue first** so we can agree on the approach before you invest time. For a security issue, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Development setup

Requirements: **Node 22+** and **pnpm 10.34.5** (`corepack enable` will pin the right pnpm).

```bash
pnpm install        # install all workspaces
pnpm build          # build everything via Turborepo
pnpm lint           # lint
pnpm dev            # run the dev servers via turbo
```

Per-app commands live in each app's `package.json`. For example, the main platform SPA:

```bash
cd apps/web/platform
pnpm dev            # Vite dev server (port 3000)
pnpm type-check     # tsc --noEmit
```

See [AGENTS.md](./AGENTS.md) for a detailed map of the monorepo, module layout, where routes vs. components live, the API/database conventions, and more. Some folders have their own `AGENTS.md` with the rules that apply there.

## How the codebase is organized

- **One API worker per module.** A module's endpoints go in its worker (`apps/workers/<module>-api`), core platform endpoints in **`apps/workers/app-api`**, organized by object (customers, tickets, …).
- **`apps/web/platform`** is a Vite SPA, **not** Next.js. No server components, server actions, or `middleware.ts`. Data fetching is client-side (TanStack Query).
- **`packages/core/db`** holds all Drizzle schema. It's multi-tenant: a master DB plus per-workspace tenant DBs.
- Internal packages are scoped `@weldsuite/*` and imported by name.

## Pull request checklist

Before you open a PR, please make sure:

- [ ] The change is scoped and focused, one logical change per PR.
- [ ] **Tenant scoping** is preserved: every database query is scoped by `workspaceId`.
- [ ] **Permission checks** are present on new or changed backend routes.
- [ ] **Validation** uses Zod (v3 in app code) on both client and server.
- [ ] **Internationalization:** any new user-visible string has entries in **both** `en` and `nl` (`packages/core/i18n/src/locales/`).
- [ ] `pnpm lint` passes in the workspace(s) you touched.
- [ ] `pnpm build` passes for the app(s) you touched.
- [ ] No stray `console.log`, `any`, or `@ts-ignore`.
- [ ] Tests added or updated where it makes sense.
- [ ] **Database schema changes** are flagged in the PR description. Do **not** commit migration files; they're generated and applied separately. Call out the schema change and let a maintainer handle the migration.
- [ ] Commit messages are meaningful (no `wip`, `fix`, `sdf`).

## Commit and PR conventions

- Write clear commit messages describing *what* changed and *why*.
- Reference the issue your PR closes (e.g. `Closes #123`).
- Keep the diff reviewable; split large work into multiple PRs when you can.

## Agent-assisted workflow

This project is developed with an agent-assisted workflow. You'll find specialist agent definitions, slash commands, and skills under `.claude/`. You're welcome to use them, but they're optional. Human review gates every change either way.

## License of contributions

By contributing, you agree that your contributions are licensed under the same terms as the project (AGPL-3.0 for the platform; the relevant permissive license for SDK packages) and that you have signed the CLA. See [CLA.md](./CLA.md).
