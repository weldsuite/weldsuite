# One branch (`main`), deploys in a private repo

Status: phase 1 in progress (2026-11-08): the open questions are answered
(end of this page), `weldsuite/weldsuite-deploy` exists with plan-only
workflows, and `deploy.yml` is split into actions and scripts. Once accepted
it supersedes ADR OPS-004
("`develop` → test, `main` → production") with a new ADR (OPS-018), and
amends OPS-005 (change-detected deploys) and the EU deploy notes in OPS-012/013.

Decided (2026-11-07):
- **One branch for the whole repo.** `develop` goes away for Global
  (Workers, Pages, Vercel, mobile OTA) and for Rust/Kubernetes alike.
- **Every merge to `main` deploys test.** Production gets a commit test
  already ran, never a new build of something else.
- **Production is a "Promote" button** in the private repo. The org is on
  GitHub Team, where an environment's required reviewers only work in public
  repos, so the button (a `workflow_dispatch` only people with write access to
  the private repo can start) is the gate.
- **Private: the deployment config and the deploy runs.** Public: the app,
  CI, image and chart builds, releases, the Helm chart and the generic
  OpenTofu/Flux base self-hosters need (OPS-014).
- **Keep friction low.** `weldsuite/deployment-overlay` (private wrangler
  configs and deploy workflows) was retired on 2026-08-19, partly because a
  change needed PRs in two repos. The rules below exist to avoid that.

## Where we are

- `weldsuite/weldsuite` is public, default branch `develop`.
- `deploy.yml` deploys `develop` pushes to test and `main` pushes to
  production. Over the last 30 days that was 475 runs: 189 of the last 200 were
  `develop`. A successful run takes about 80 job-minutes.
  `deploy-hosted-apps.yml` ran 27 times.
- Everything about those runs is public: logs, the Deployments list, the
  `test`/`production` environments.
- Rulesets: `develop` requires PRs and the checks `Lint`, `Build`,
  `Type Check · app-api`, `Type Check · platform`, `Unit · app-api`,
  `Unit · platform` and `Rust`, and blocks deletion and force pushes. `main`
  allows merge commits only. Both require `WeldSuite Review`.
- **EU:** `rust-images.yml` builds `develop`, tags `sha-<12>` and `develop`,
  and publishes the chart as `<base>-develop.<run>`. The test cluster follows
  the newest one. `rust-release.yml` promotes a `develop` build to `X.Y.Z`
  for production.
- Flux reads the whole of `rust/deploy/flux` from the public repo over
  anonymous HTTPS, cluster folders included. That covers the test cluster's
  settings (domain, buckets, Zitadel IDs), its SOPS-encrypted secrets and the
  runbooks. The org doesn't allow deploy keys.
- Production's base layers (`infrastructure/*`, `apps/eu`) come from `main`
  today. Only the chart and images are pinned to a release.

## Target picture

```
PR ──► CI (public, required checks) ──► merge to main
                                          │
                     ┌────────────────────┴─────────────────────┐
                     ▼                                          ▼
     CI on main + Rust images/chart                hand-off (public job, logs only
     sha-<12>, `main`, <base>-main.<run>            "handed <sha> to deploy")
     (public)                                                   │
                     │                                          ▼
                     │                       weldsuite-deploy (private)
                     │                       deploy → test (Global)
                     ▼                                          │
     EU test cluster: Flux picks up                             ▼
     the newest -main chart                    "Promote" button (private):
                                               - Global → production, same sha
                                               - EU: public rust-release X.Y.Z,
                                                 then bump the version in the
                                                 private cluster settings
                                                                │
                                                                ▼
                                               Flux rolls out EU production
```

### What lives where

| Public `weldsuite/weldsuite` | Private `weldsuite/weldsuite-deploy` |
|---|---|
| App code, CI, required checks | Deploy workflows: `deploy` (test), `promote` (production) |
| Deploy logic: scripts and composite actions (change detection, worker matrix, migrations, Vercel, Pages, OTA) | GitHub Environments `test` and `production` with their secrets |
| `wrangler.toml` files with resource IDs (not secrets; they change with code) | Last deployed commit per environment (from its own run history) |
| `rust-images.yml`, `rust-release.yml`, the chart, images and releases | EU cluster folders: `clusters/{eu,test,drill}` with settings, layers and cluster patches (sizing, restore bootstraps) |
| Flux base: `rust/deploy/flux/infrastructure/*`, `apps/eu` | SOPS secrets `secrets/{eu,test,drill}` and `.sops.yaml` |
| OpenTofu module `rust/deploy/hetzner` with example tfvars, `validate.sh`, an example cluster | Real tfvars (domain, `admin_cidrs`), OpenTofu state config |
| Generic install guide (today's Hetzner README without WeldSuite's own hosts) | Ops runbooks: TEST-CLUSTER.md, the drill's specifics, production steps with real domains |

### Rules that keep it to one PR

1. **What changes with code stays public**: `wrangler.toml`, the chart and
   its defaults, the Flux base, and the deploy logic itself. A code PR never
   needs a second PR in the private repo.
2. **The private workflows are thin.** They check out the public repo at
   the exact commit as their workspace and run its deploy logic from there
   (`uses: ./.github/actions/deploy-…`, `node .github/scripts/…`). Not into
   a subfolder: composite actions call each other by workspace path
   (`./.github/actions/setup-monorepo`), which a subfolder breaks. Every
   deploy target is named in `.github/scripts/deploy-plan.mjs` and the
   per-app jobs are matrices over its lists, so adding a worker or an app
   changes only the public repo.
3. **New chart values get a default in the chart.** The private cluster
   settings only override (domain, sizes, IDs, version).
4. **The private repo changes rarely**: a new cluster, a secret, sizing, a
   promotion. If more than about one in twenty code PRs needs a private PR
   too, something is in the wrong repo.
5. **Check the commit before any public code runs.** A commit from a fork
   can be checked out through the parent repo by its sha, so the private
   workflows check inline (with the API, not with a script from the commit)
   that it is on the branch and its CI passed, and only then check it out.

## Phases

### 0. Decide and record

- ADR OPS-018 "One branch, `main`; deploys run in a private repo; production
  is promoted", superseding OPS-004. Amend OPS-005 (where change detection
  runs, diff base per environment) and the EU parts of OPS-012/013 (production
  base layers pinned to the release tag, Flux reads a private repo).
- Update `design/platform/ci-cd-and-infrastructure.md` and the EU section of
  `editions-and-self-hosting.md` in the docs repo.

### 1. Private repo and plumbing (no behaviour change)

- Create `weldsuite/weldsuite-deploy` (private). Archive `deployment-overlay`.
- Two GitHub Apps, least privilege:
  - `weldsuite-deploy-bot`: Actions read/write, installed on
    `weldsuite-deploy` only. The public hand-off uses it to start the private
    `deploy-test` workflow (`workflow_dispatch`), which checks its input: the
    sha is on the branch and its CI passed. Never on the public repo: Actions
    write would let it start `publish-cli`, `mobile-build` or
    `release-desktop` with any inputs. A leaked key can deploy a commit
    already on the branch to test, or cancel and disable private runs;
    Promote refuses bots. The public `rust-release` stays a maintainer's
    button (phase 4).
  - `weldsuite-flux-reader`: Contents read, on `weldsuite-deploy` only. Flux
    uses it in phase 4 (no deploy keys needed).
- Create Environments `test` and `production` in the private repo. Fill them
  from Doppler the way `.github/SECRETS.md` describes, pointed at the new
  repo.
- In the public repo, split `deploy.yml` into composite actions and scripts
  under `.github/actions/deploy-*` and `.github/scripts/`. The public
  `deploy.yml` keeps working on top of them, so this is a refactor with no
  change in behaviour.
- Add the private `deploy.yml` (reusable, inputs `sha`, `environment`), and
  `deploy-test.yml` and `promote.yml` on top of it, with concurrency per
  environment so the newest commit wins. The diff base is the last
  successful deploy of that environment: each live deploy records its
  commit as a deployment in the private repo (task `deploy:weldsuite`, the
  commit in `payload.sha`), which works for Promote too, where the commit
  can be picked inside the run. Until the private repo has one, the public
  `deploy.yml` history is the fallback.
- First run them in plan-only mode next to the public deploys and compare
  what each would deploy. In phase 1 nothing hands commits over yet, so a
  private `plan-watch` workflow polls every 30 minutes: it plans each commit
  the public `deploy.yml` deployed, with the diff base that run used, and
  compares the plan with the jobs the public run ran (a red run is a
  mismatch). It goes away in phase 2.

### 2. Move Global's deploy runs to the private repo (branch mapping unchanged)

- Public `handoff.yml`: when `CI` finishes successfully on a push, it starts
  the private deploy with the sha and the environment (`develop` → test,
  `main` → production, until phase 3). The App key sits in a public
  environment `handoff` that only `develop`/`main` can use, so fork PRs never
  see it.
- After a week of matching runs, remove the deploy jobs from the public
  `deploy.yml` and move `deploy-hosted-apps.yml` across too. Then delete the
  public environments `test`/`production` with their secrets, and the old
  deployment records (including the leftover Vercel `Preview – …` ones).
- These stay public: `ci.yml`, `secret-scan.yml`, `i18n-check.yml`,
  `sonarjs.yml`, `rust-images.yml`, `rust-release.yml` (public releases for
  self-hosters), `publish-cli.yml` (npm trusted publishing is bound to this
  repo's workflow), `mobile-build.yml` and `release-desktop.yml` (builds of
  public artifacts, run by hand; they can move later if their logs matter).

### 3. Only `main`

- **Freeze.** Pause merges and merge `develop` into `main`, so `main` holds
  everything.
- **Branch settings:**
  - Make `main` the default branch.
  - Move the `develop` ruleset to `main` (PRs, the seven checks including
    `Rust`, no deletion or force push) and keep `WeldSuite Review`.
  - Use the merge methods `develop` allowed. Drop "merge commits only",
    which existed for `develop` → `main` merges.
  - Retarget the open PRs. Three target `develop` today.
- **Workflows:**
  - `ci.yml`, `secret-scan.yml` and `i18n-check.yml` run on PRs and on pushes
    to `main` only.
  - `rust-images.yml` builds `main` and tags `main` instead of `develop`. The
    chart becomes `<base>-main.<run>`.
  - `rust-release.yml` checks that the commit is on `main`.
  - Base branch `main` in `.github/scripts/ci-changes.mjs`,
    `module-workers.mjs`, `scripts/lint-sonar-new.mjs` and
    `scripts/rust-conformance.ts`.
  - Hand-off: every green `main` → deploy test.
- **Promote (private `promote.yml`)**:
  - **Inputs:** `sha` (defaults to the newest commit test deployed) and
    targets (`global`, `eu`).
  - **Checks:** the sha is on `main`, its CI passed, and test deployed it.
  - **Global:** a production deploy of that sha. Its diff base is the last
    production sha, which may be many commits back.
  - **EU:** start the public `rust-release` with `sha-<12>` and the next
    version, wait for it, then commit `WELDSUITE_VERSION` and the base-layer
    tag (phase 4) to `clusters/eu` and `clusters/drill`.
  - **Mobile:** OTA test → `preview` on every main deploy; `production`
    channel on promote.
- **Retire `develop`.** Keep it read-only for two weeks (a ruleset blocks
  pushes), then delete it.
- **Words:**
  - Repo files: `CLAUDE.md` (CI/CD section and the "Push `develop` …"
    lines), `AGENTS.md`, `CONTRIBUTING.md`, `.github/SECRETS.md`.
  - Claude tooling: `.claude/commands/fix-issue.md`,
    `.claude/ISSUE-FIX-WORKFLOW.md`, the skills `weldtask` and
    `weldsuite-docs` (PRs against `main`), `.claude/workflows/*`.
  - Readmes and comments: `apps/hosted-apps/README.md`,
    `apps/web/sign-portal/README.md`, `apps/web/platform/e2e/README.md`, and
    the comments in the `wrangler.toml` files.
  - Docs repo: links to `blob/develop` → `blob/main`.
  - Most other `develop` hits are the `weldapps:develop` permission, which
    stays as it is.

### 4. EU deployment config private

- **Private repo layout:**
  - `eu/clusters/{eu,test,drill}/`: settings, layers, and the cluster
    patches, including the test sizing and the restore bootstraps that today
    live in `infrastructure/configs/test`.
  - `eu/secrets/…` and `.sops.yaml`.
  - `eu/hetzner/*.tfvars` and the ops runbooks.
- **Flux, two sources per cluster:**
  - Public `weldsuite` GitRepository (anonymous HTTPS) for the base layers.
    Test follows the `main` branch. Production and the drill follow the tag
    `weldsuite-vX.Y.Z`, which Promote writes together with
    `WELDSUITE_VERSION`. Base-layer changes then reach production only
    through a promotion. Today they come straight from `main`.
  - Private `deploy` GitRepository with `provider: github` (Flux's GitHub App
    auth, Flux 2.5 and later; the pinned 2.9.6 has it), using
    `weldsuite-flux-reader`. It holds the cluster folder and the secrets.
- **Move the test cluster first.** Create both sources, point the
  `flux-system` Kustomization at the private path, and check that every layer
  reconciles. Then delete `clusters/*`, `secrets/*` and the WeldSuite-specific
  runbooks from the public repo. Production (not built yet) starts in the
  private repo.
- **Validation:**
  - Public CI runs `validate.sh` against the base and an example cluster with
    placeholders.
  - Private CI runs the same `validate.sh`, taken from the public repo at
    `main`, against the real clusters. That covers kubeconform, the version
    pins, and a check that secrets are encrypted.
- **History:** the public history keeps the test cluster's settings and its
  SOPS ciphertext. The ciphertext is safe while the age key is private.
  Rotate the test cluster's secrets after the move anyway, since it is
  cheap. Production secrets are only ever created in the private repo.

## What stays public, on purpose

- CI on PRs and on `main`, image and chart builds, and releases (tags,
  images, charts). Self-hosters and AGPL users need them.
- The hand-off job, whose log only says which commit was handed over.
- `wrangler.toml` resource IDs. They aren't secrets, and moving them was what
  made the overlay painful.
- Everything already in the public history.

## Costs and risks

- **Actions minutes.** Public repos run free. In the private repo, deploy
  runs count against Team's 3,000 included minutes a month. At today's rate
  of about 475 deploy runs and 80 job-minutes per successful run, the upper
  bound is about 38,000 job-minutes a month, which would cost a few hundred
  dollars a month at GitHub's per-minute price. Cancelled runs are shorter,
  and collapsing bursts lowers it further. Options:
  - Accept it.
  - Collapse merge bursts harder (one test deploy per few minutes).
  - Run the private deploy jobs on a self-hosted runner on Hetzner, about
    €20–36 a month for a CPX22/CPX32. Allowed and free of GitHub charges
    today (see the answered questions below).

  Measure for a week in phase 1 before choosing.
- **No second pair of eyes on production.** Anyone with write access to the
  private repo can promote. Keep that group small. GitHub Enterprise (about
  $21 instead of $4 per user per month) would add required reviewers if a
  four-eyes rule is ever needed.
- **A broken merge breaks test for everyone.** That's the same as `develop`
  today, and production stays behind Promote.
- **Two repos again.** The rules above keep the private repo to things that
  change rarely. Review the one-in-twenty measure after a month.
- **Cutover.** Phase 3 needs a short merge freeze, and every open branch
  must be rebased or retargeted onto `main`.

## Open questions, answered (2026-11-08)

- **Does every promotion cut an EU release version (`X.Y.Z`)?** Yes. Every
  EU Promote cuts a new `X.Y.Z`. The self-hosted `stable` (monthly) and `lts`
  (yearly) channels of OPS-014 are cut separately and point at chosen
  versions, so EU production's cadence and the self-hosted channels don't
  hold each other up.
- **Can deploy jobs run on a self-hosted runner?** Yes, and today it costs
  nothing extra. GitHub announced a $0.002 per minute platform charge for
  self-hosted runners from 2026-03-01, then postponed it. As of
  October 2026 it is not in effect and has no new date, and GitHub's billing
  docs still list self-hosted runner use as free. Hosted runner prices went
  down by up to 39% on 2026-01-01. Whether to use one is still the phase 1
  measurement's call (task "Plan-only week"); re-check GitHub's billing docs
  before choosing, since the charge may come back.
- **`release-desktop.yml` and `mobile-build.yml`: public or private?**
  Public. They build public artifacts and run by hand. They use the public
  `production`/`test` environments today (`release-desktop`: the Apple and
  Windows signing secrets and `R2_DOWNLOADS_API_TOKEN`; `mobile-build`:
  `EXPO_TOKEN`), which the phase 2 cut-over deletes. So before that, they
  get their own public environments, holding only their secrets, limited to
  the branch they release from: `desktop-release` (main), and for
  `mobile-build` `mobile-release` (production channel, main) and
  `mobile-preview` (preview channel, develop), the same branch split as
  today.
