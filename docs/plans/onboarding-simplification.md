# Simpler workspace onboarding

## Problem

The signup wizard requires four steps: profile, organization, role, and apps.
Users must repeat profile information and provide team size and referral source
before they can start, even though these fields are optional in provisioning.

## Implementation plan

1. Replace the wizard with one screen requiring only a workspace name.
2. Reuse the authenticated profile; defer photo uploads and profile editing to Settings.
3. Suggest the existing country/storage defaults and display the region upfront.
   Put location controls in an expandable section; preserve deliberate region overrides.
4. Make app selection optional and keyboard accessible, with an App Store path later.
   App catalog loading or failure must not block workspace creation.
5. Omit role, team size, referral, and marketing fields rather than inventing answers
   or overwriting existing preferences.
6. Preserve duplicate-submit protection, error retry, org activation, provisioning,
   finalization, and invitation routing.
7. Add English/Dutch copy, update help documentation and real UI screenshots,
   and update component regression coverage and the signup E2E scenario.

## Acceptance criteria

- A user can create a workspace by entering only its name, including with no profile name or available apps.
- Empty/whitespace-only names cannot submit; submitted names are trimmed.
- Apps may be selected, deselected, or deferred completely.
- Country changes update the suggested region unless the user explicitly chose a region.
- Submission failures retain input and allow retry; in-flight submissions cannot repeat.
- No database migration or change to billing, auth, or provisioning is required.

## Verification

Completed locally:

- Six Vitest regression tests passed.
- Platform TypeScript check passed with an 8 GB heap.
- Platform production build and distribution integrity check passed.
- Docs production build and all help screenshot captures passed.
- Desktop (1440 px) and mobile (390 px) browser checks passed, including expanded
  settings, whitespace validation, region overrides, empty catalog, and no runtime
  errors or horizontal overflow. Screenshots were visually reviewed.
- `git diff --check` passed.

The installed pnpm 11 runtime attempts dependency installation before running
scripts; verification used installed scripts directly or
`pnpm_config_verify_deps_before_run=false` to avoid changing dependencies.

Limitations:

- ESLint 9 cannot run because this workspace has no flat ESLint config.
- The live signup E2E was updated but not executed against Clerk/Neon. It requires
  the existing test-fixture credentials and must not run against production.
- The graphify launcher failed inside the sandbox; automatic approval review
  declined an escalated update because `/graphify` was not explicitly requested.
  No knowledge graph was updated.
