# Monthly drill: build, restore, check, tear down

While the EU edition is dormant (no customer yet), the cluster does not run.
Once a month the drill proves it still can: it builds a fresh cluster on
Hetzner from this repository, restores production's latest Postgres backup
into it, checks it, and destroys it. It also catches Hetzner server types that
are no longer available (Hetzner has listed "limited availability" of cloud
instances since April 2026).

Run it with `scripts/drill.sh` on the **drill runner**: a small always-on EU
machine (P5 work package 5.6) that holds the drill's Hetzner token, age key
and a read-only deploy key. It never runs on GitHub, so GitHub holds no EU
credentials.

## What it does

1. **Infrastructure.** `tofu apply` in the `drill` workspace with
   `cluster_name=weldsuite-drill` (its own servers, network and load
   balancers; a separate Hetzner project is best).
2. **Flux, read only.** `flux install`, then a `GitRepository` and a
   `Kustomization` for `rust/deploy/flux/clusters/drill`. Nothing is pushed
   to the repository.
3. **Restore.** The drill overlay (`flux/infrastructure/configs/drill`)
   starts `master`, `tenants-1` and `zitadel-db` from the latest backup in
   production's object store (`bootstrap.recovery`), archives their own WAL
   under `drill/`, and turns the scheduled backups off. The drill's secrets
   (`flux/secrets/drill`) carry production's Postgres owner passwords and
   encryption keys, because the restored databases come with production's
   roles and encrypted database URLs.
4. **Checks.** Every Flux layer ready; the three Postgres clusters ready; the
   restored master has workspaces; the weldsuite server rolls out and answers
   `/readyz` and `/health`.
5. **Teardown.** `tofu destroy`, also when a step fails (set `KEEP=1` to
   inspect a failure first, then destroy by hand).

## Running it

```bash
export HCLOUD_TOKEN=…                 # the drill project's token
export DRILL_TFVARS=drill.tfvars      # domain, admin_cidrs (the runner's address)
export DRILL_AGE_KEY=drill.agekey
export DEPLOY_KEY=weldsuite-deploy-key   # read-only
rust/deploy/hetzner/scripts/drill.sh
```

The script prints the server types it got. When a type is unavailable, set
another in `drill.tfvars` (and then in production's), and record it.

## After a run

Record the date, the result, how long the restore took (the recovery point
and time objectives) and any type substitutions in the operations log. A
failed drill is an incident: production's backups may not be restorable.

## Still to build

- The smoke suite of the core platform, know and sign against the restored
  data (P5 exit criterion); today the checks stop at the server's health.
- The runner itself: a scheduled job (cron or a systemd timer) on the EU
  machine, alerting to the EU channel on failure (5.5, 5.6).
