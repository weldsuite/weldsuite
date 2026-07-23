#!/usr/bin/env npx tsx
/**
 * Generate .dev.vars files for local development from Doppler.
 *
 * Usage:
 *   DOPPLER_TOKEN=dp.xxx pnpm secrets:dev [worker1 worker2 ...]
 *
 * Environment variables:
 *   DOPPLER_TOKEN     — Doppler personal or service token (required)
 *   DOPPLER_PROJECT   — Doppler project name (default: "weldsuite")
 *   DOPPLER_CONFIG    — Doppler config to read from (default: "dev")
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifest } from "./manifest";

const DOPPLER_PROJECT = process.env.DOPPLER_PROJECT || "weldsuite";
const DOPPLER_CONFIG = process.env.DOPPLER_CONFIG || "dev";

// ── Doppler API ──────────────────────────────────────────────

async function fetchSecrets(token: string): Promise<Record<string, string>> {
  const url = new URL("https://api.doppler.com/v3/configs/config/secrets");
  url.searchParams.set("project", DOPPLER_PROJECT);
  url.searchParams.set("config", DOPPLER_CONFIG);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Doppler API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    secrets: Record<string, { computed: string }>;
  };

  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(data.secrets)) {
    if (!key.startsWith("DOPPLER_")) {
      secrets[key] = val.computed;
    }
  }
  return secrets;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const workerFilter = process.argv.slice(2);

  const token = process.env.DOPPLER_TOKEN;
  if (!token) {
    console.error("\nMissing DOPPLER_TOKEN environment variable.");
    console.error(
      "Create one at: Doppler Dashboard > Project > Access > Tokens\n",
    );
    process.exit(1);
  }

  console.log(
    `\nFetching secrets from Doppler (project=${DOPPLER_PROJECT}, config=${DOPPLER_CONFIG})...\n`,
  );
  const allSecrets = await fetchSecrets(token);
  console.log(`Found ${Object.keys(allSecrets).length} secrets in Doppler.\n`);

  const entries = workerFilter.length
    ? Object.entries(manifest).filter(([dir]) => workerFilter.includes(dir))
    : Object.entries(manifest);

  for (const [workerDir, secretNames] of entries) {
    const workerPath = join(process.cwd(), "apps", "workers", workerDir);

    if (!existsSync(workerPath)) {
      console.warn(`  ⚠ ${workerDir}: Directory not found, skipping`);
      continue;
    }

    const lines: string[] = [
      "# Auto-generated from Doppler — do not edit manually",
      `# Run: pnpm secrets:dev${workerFilter.length ? ` ${workerDir}` : ""}`,
      "",
    ];

    let count = 0;
    for (const name of secretNames) {
      if (name in allSecrets) {
        lines.push(`${name}=${allSecrets[name]}`);
        count++;
      }
    }

    const devVarsPath = join(workerPath, ".dev.vars");
    writeFileSync(devVarsPath, lines.join("\n") + "\n");
    console.log(`  ✓ ${workerDir}: ${count} secrets → .dev.vars`);
  }

  console.log("\nDone. Run `pnpm dev` to start workers with local secrets.\n");
}

main();
