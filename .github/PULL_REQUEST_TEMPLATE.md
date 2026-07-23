<!--
Thanks for contributing to WeldSuite! Please fill this out so reviewers have the
context they need. First-time contributors will be asked to sign the CLA.
-->

## What & why

<!-- What does this PR do, and why is it needed? Link the issue it addresses. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Other:

## Checklist

- [ ] Focused, single logical change
- [ ] Every DB query is scoped by `workspaceId` (tenant isolation preserved)
- [ ] Permission checks present on new/changed backend routes
- [ ] Zod (v3) validation on both client and server, where applicable
- [ ] New user-visible strings added to **both** `en.json` and `nl.json`
- [ ] `pnpm lint` passes in the changed workspace(s)
- [ ] `pnpm build` passes for the changed app(s)
- [ ] No stray `console.log`, `any`, or `@ts-ignore`
- [ ] Tests added/updated where appropriate
- [ ] Schema changes (if any) are described below, **no migration files committed**

## Schema changes

<!-- If you touched packages/core/db schema, describe what changed. Otherwise "None". -->

None

## Screenshots / notes

<!-- For UI changes, add before/after screenshots. Anything else reviewers should know? -->
