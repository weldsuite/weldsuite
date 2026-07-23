#!/usr/bin/env npx tsx
/**
 * Sync secrets from Doppler to Cloudflare Workers.
 *
 * Usage:
 *   DOPPLER_TOKEN=dp.xxx pnpm secrets:sync <test|preview|production> [worker1 worker2 ...]
 *
 * Environment variables:
 *   DOPPLER_TOKEN     — Doppler personal or service token (required)
 *   DOPPLER_PROJECT   — Doppler project name (default: "weldsuite")
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — required by wrangler
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifest } from "./manifest";

const DOPPLER_PROJECT = process.env.DOPPLER_PROJECT || "weldsuite";
const VALID_ENVS = ["test", "preview", "production"] as const;
type Env = (typeof VALID_ENVS)[number];

// ── Doppler API ──────────────────────────────────────────────

async function fetchSecrets(
  token: string | null,
  config: string,
): Promise<Record<string, string>> {
  // Prefer the API when a DOPPLER_TOKEN is provided (CI). Otherwise fall back to
  // the locally-authenticated Doppler CLI (`doppler login`) — handy when running
  // interactively without minting a token.
  const raw: Record<string, string> = token
    ? await fetchViaApi(token, config)
    : fetchViaCli(config);

  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!key.startsWith("DOPPLER_")) secrets[key] = val;
  }
  return secrets;
}

async function fetchViaApi(token: string, config: string): Promise<Record<string, string>> {
  const url = new URL("https://api.doppler.com/v3/configs/config/secrets");
  url.searchParams.set("project", DOPPLER_PROJECT);
  url.searchParams.set("config", config);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Doppler API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { secrets: Record<string, { computed: string }> };
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(data.secrets)) out[key] = val.computed;
  return out;
}

function fetchViaCli(config: string): Record<string, string> {
  try {
    const json = execSync(
      `doppler secrets download --no-file --format json --project ${DOPPLER_PROJECT} --config ${config}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(json) as Record<string, string>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Doppler CLI read failed (project=${DOPPLER_PROJECT}, config=${config}). ` +
        `Run \`doppler login\` (or set DOPPLER_TOKEN). Original: ${msg}`,
    );
  }
}

// ── Wrangler bulk upload ─────────────────────────────────────

function syncWorker(
  workerDir: string,
  env: Env,
  secrets: Record<string, string>,
): void {
  const tmpFile = join(
    tmpdir(),
    `weldsuite-secrets-${workerDir}-${Date.now()}.json`,
  );
  writeFileSync(tmpFile, JSON.stringify(secrets));

  try {
    execSync(`npx wrangler secret bulk "${tmpFile}" --env ${env}`, {
      cwd: join(process.cwd(), "apps", "workers", workerDir),
      stdio: "inherit",
    });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const [env, ...workerFilter] = process.argv.slice(2);

  if (!env || !VALID_ENVS.includes(env as Env)) {
    console.error(
      `\nUsage: pnpm secrets:sync <${VALID_ENVS.join("|")}> [worker ...]\n`,
    );
    console.error("Examples:");
    console.error("  pnpm secrets:sync test");
    console.error("  pnpm secrets:sync production api-worker billing-worker\n");
    process.exit(1);
  }

  const token = process.env.DOPPLER_TOKEN || null;
  const source = token ? "DOPPLER_TOKEN (API)" : "Doppler CLI login";

  // The Doppler *config* name may differ from the wrangler *env* name (e.g.
  // Doppler "prd" → wrangler "production"). Override with DOPPLER_CONFIG.
  const dopplerConfig = process.env.DOPPLER_CONFIG || env;

  // Fetch all secrets from Doppler for this environment
  console.log(
    `\nFetching secrets from Doppler via ${source} (project=${DOPPLER_PROJECT}, config=${dopplerConfig})...\n`,
  );
  const allSecrets = await fetchSecrets(token, dopplerConfig);
  console.log(`Found ${Object.keys(allSecrets).length} secrets in Doppler.\n`);

  // Determine which workers to sync
  const entries = workerFilter.length
    ? Object.entries(manifest).filter(([dir]) => workerFilter.includes(dir))
    : Object.entries(manifest);

  if (entries.length === 0) {
    console.error(
      `No matching workers. Available: ${Object.keys(manifest).join(", ")}`,
    );
    process.exit(1);
  }

  let failed = 0;

  for (const [workerDir, secretNames] of entries) {
    // Check worker directory exists
    if (!existsSync(join(process.cwd(), "apps", "workers", workerDir))) {
      console.warn(`  ⚠ ${workerDir}: Directory apps/workers/${workerDir} not found, skipping`);
      continue;
    }

    // Pick only the secrets this worker needs
    const workerSecrets: Record<string, string> = {};
    const missing: string[] = [];

    for (const name of secretNames) {
      if (name in allSecrets) {
        workerSecrets[name] = allSecrets[name];
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      console.warn(
        `  ⚠ ${workerDir}: Not found in Doppler: ${missing.join(", ")}`,
      );
    }

    if (Object.keys(workerSecrets).length === 0) {
      console.log(`  ⏭ ${workerDir}: No secrets to sync\n`);
      continue;
    }

    console.log(
      `  → ${workerDir}: Syncing ${Object.keys(workerSecrets).length} secrets...`,
    );

    try {
      syncWorker(workerDir, env as Env, workerSecrets);
      console.log(`  ✓ ${workerDir}: Done\n`);
    } catch {
      console.error(`  ✗ ${workerDir}: Failed\n`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} worker(s) failed.`);
    process.exit(1);
  }

  console.log("All secrets synced successfully.\n");
}

main();
