#!/usr/bin/env npx tsx
/**
 * Put a SINGLE Doppler secret onto a Cloudflare Worker via `wrangler secret put`.
 *
 * Unlike sync.ts (bulk, manifest-driven), this targets one secret on one worker —
 * handy for a one-off fix without re-running the whole sync.
 *
 * Usage:
 *   DOPPLER_TOKEN=dp.xxx npx tsx scripts/secrets/put.ts <env> <worker-dir> <SECRET_NAME> [DOPPLER_KEY]
 *
 *   <env>          test | preview | production  (also the Doppler config name)
 *   <worker-dir>   directory under apps/workers/ (e.g. app-api, integration-webhook-worker)
 *   <SECRET_NAME>  the secret name on the worker (and Doppler key, unless DOPPLER_KEY given)
 *   [DOPPLER_KEY]  optional: read this Doppler key instead of <SECRET_NAME>
 *
 * Environment:
 *   DOPPLER_TOKEN   — Doppler personal or service token (required)
 *   DOPPLER_PROJECT — Doppler project name (default: "weldsuite")
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — required by wrangler in CI
 *
 * Examples:
 *   DOPPLER_TOKEN=dp.xxx npx tsx scripts/secrets/put.ts production app-api GITHUB_APP_SLUG
 *   DOPPLER_TOKEN=dp.xxx npx tsx scripts/secrets/put.ts production integration-webhook-worker GITHUB_WEBHOOK_SECRET
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DOPPLER_PROJECT = process.env.DOPPLER_PROJECT || "weldsuite";
const VALID_ENVS = ["test", "preview", "production"] as const;
type Env = (typeof VALID_ENVS)[number];

async function fetchSecret(token: string, config: string, key: string): Promise<string> {
  const url = new URL("https://api.doppler.com/v3/configs/config/secret");
  url.searchParams.set("project", DOPPLER_PROJECT);
  url.searchParams.set("config", config);
  url.searchParams.set("name", key);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Doppler API ${res.status} for "${key}": ${body}`);
  }

  const data = (await res.json()) as { value?: { computed?: string } };
  const value = data.value?.computed;
  if (value == null) {
    throw new Error(`Doppler returned no value for "${key}" in config "${config}"`);
  }
  return value;
}

async function main() {
  const [env, worker, secretName, dopplerKeyArg] = process.argv.slice(2);

  if (!env || !VALID_ENVS.includes(env as Env) || !worker || !secretName) {
    console.error(
      "\nUsage: DOPPLER_TOKEN=dp.xxx npx tsx scripts/secrets/put.ts " +
        `<${VALID_ENVS.join("|")}> <worker-dir> <SECRET_NAME> [DOPPLER_KEY]\n`,
    );
    process.exit(1);
  }

  const token = process.env.DOPPLER_TOKEN;
  if (!token) {
    console.error("\nMissing DOPPLER_TOKEN environment variable.");
    console.error("Create one at: Doppler Dashboard > Project > Access > Tokens\n");
    process.exit(1);
  }

  const workerDir = join(process.cwd(), "apps", "workers", worker);
  if (!existsSync(workerDir)) {
    console.error(`\nWorker directory not found: apps/workers/${worker}\n`);
    process.exit(1);
  }

  const dopplerKey = dopplerKeyArg || secretName;

  console.log(`\nFetching "${dopplerKey}" from Doppler (project=${DOPPLER_PROJECT}, config=${env})...`);
  const value = await fetchSecret(token, env, dopplerKey);

  console.log(`Putting "${secretName}" onto ${worker} (env=${env})...`);
  execSync(`npx wrangler secret put ${secretName} --env ${env}`, {
    cwd: workerDir,
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });

  console.log(`\n✓ ${secretName} set on ${worker} (${env}).\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
