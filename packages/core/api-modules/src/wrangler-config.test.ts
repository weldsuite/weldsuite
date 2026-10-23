/**
 * Guard: a worker's top-level wrangler.toml config (no `--env`) is its local
 * `wrangler dev` config and must never be able to land on a deployed worker.
 *
 * The top-level config carries development values (ENVIRONMENT=development,
 * dev/test resource ids, and in app-api the /test-fixtures router that can
 * hard-delete workspaces). When its `name` equals the `[env.production]` name,
 * a `wrangler deploy` (or `secret put`, `tail`) without `--env` targets the
 * production worker. So, for every config that defines environments:
 *
 *   - each `[env.*]` sets its own `name` (an inherited one would be derived
 *     from the top-level name);
 *   - the top-level `name` is not the name of any deployed worker;
 *   - top-level service bindings and Durable Object / Workflow `script_name`s
 *     point at other workers' local names, or at a deployed worker only through
 *     an explicit `remote = true` binding;
 *   - no `[env.*]` binding points at a local (top-level) name.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APPS_DIR = path.resolve(__dirname, '../../../../apps');

interface Block {
  /** `''` for the top-level table, else the header, e.g. `env.test.services`. */
  section: string;
  values: Map<string, string>;
}

interface WranglerConfig {
  file: string;
  blocks: Block[];
}

/** Just enough TOML for `key = "string"` / `key = true` lines, grouped by table header. */
function parse(file: string): WranglerConfig {
  const blocks: Block[] = [{ section: '', values: new Map() }];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      blocks.push({ section: header[1]!.trim(), values: new Map() });
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|(true|false))/.exec(line);
    if (kv) blocks.at(-1)!.values.set(kv[1]!, kv[2] ?? kv[3]!);
  }
  return { file: path.relative(APPS_DIR, file).replaceAll('\\', '/'), blocks };
}

function wranglerConfigs(): WranglerConfig[] {
  const configs: WranglerConfig[] = [];
  for (const group of readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const app of readdirSync(path.join(APPS_DIR, group.name), { withFileTypes: true })) {
      const file = path.join(APPS_DIR, group.name, app.name, 'wrangler.toml');
      if (app.isDirectory() && existsSync(file)) configs.push(parse(file));
    }
  }
  return configs;
}

/** Top-level `name`: the first `name` before any table header. */
function topLevelName(config: WranglerConfig): string | undefined {
  return config.blocks[0]!.values.get('name');
}

/** `[env.<x>]` blocks (not their sub-tables such as `[env.x.vars]`). */
function envBlocks(config: WranglerConfig): Block[] {
  return config.blocks.filter((b) => /^env\.[^.]+$/.test(b.section));
}

const isTopLevel = (b: Block) => !b.section.startsWith('env.');

describe('wrangler.toml top-level (local dev) config', () => {
  const configs = wranglerConfigs();
  // A config without environments is deployed as is (e.g. test-email-worker).
  const withEnvs = configs.filter((c) => envBlocks(c).length > 0);
  const deployedNames = new Set(withEnvs.flatMap((c) => envBlocks(c).map((b) => b.values.get('name') ?? '')));

  it('finds the workers', () => {
    expect(withEnvs.map((c) => c.file)).toContain('workers/app-api/wrangler.toml');
  });

  it('gives every environment its own name', () => {
    const offenders = withEnvs.flatMap((c) =>
      envBlocks(c)
        .filter((b) => !b.values.get('name'))
        .map((b) => `${c.file} [${b.section}]`),
    );
    expect(offenders, 'set `name` in these environments').toEqual([]);
  });

  it('never uses the name of a deployed worker', () => {
    const offenders = withEnvs
      .filter((c) => deployedNames.has(topLevelName(c) ?? ''))
      .map((c) => `${c.file}: ${topLevelName(c)}`);
    expect(offenders, 'rename the top-level `name` (e.g. to `<name>-dev`)').toEqual([]);
  });

  it('binds deployed workers only through remote bindings', () => {
    const offenders = withEnvs.flatMap((c) =>
      c.blocks.filter(isTopLevel).flatMap((b) =>
        (['service', 'script_name'] as const)
          .map((key) => b.values.get(key))
          .filter((target): target is string => !!target && deployedNames.has(target))
          .filter(() => b.values.get('remote') !== 'true')
          .map((target) => `${c.file} [${b.section}] → ${target}`),
      ),
    );
    expect(offenders, 'point local bindings at the `-dev` name, or add `remote = true`').toEqual([]);
  });

  it('is never bound by a deployed environment', () => {
    const localNames = new Set(withEnvs.map((c) => topLevelName(c) ?? ''));
    const offenders = withEnvs.flatMap((c) =>
      c.blocks
        .filter((b) => !isTopLevel(b))
        .flatMap((b) =>
          (['service', 'script_name'] as const)
            .map((key) => b.values.get(key))
            .filter((target): target is string => !!target && localNames.has(target))
            .map((target) => `${c.file} [${b.section}] → ${target}`),
        ),
    );
    expect(offenders, 'deployed environments bind the deployed name, not the `-dev` one').toEqual([]);
  });
});

/**
 * The WeldHost DNS sandbox (`@weldsuite/cloudflare-zones/sandbox`) stands in
 * for Cloudflare on test. In production it would silently keep customer DNS
 * out of Cloudflare, so production may carry neither its switch nor its D1.
 */
describe('WeldHost DNS sandbox', () => {
  const configs = wranglerConfigs();

  it('is never configured for production', () => {
    const offenders = configs.flatMap((c) =>
      c.blocks
        .filter((b) => b.section === 'env.production' || b.section.startsWith('env.production.'))
        .flatMap((b) => {
          const found: string[] = [];
          if (b.values.has('WELDHOST_DNS_MODE')) found.push('WELDHOST_DNS_MODE');
          if (b.values.get('binding') === 'DNS_SANDBOX') found.push('DNS_SANDBOX binding');
          return found.map((what) => `${c.file} [${b.section}] ${what}`);
        }),
    );
    expect(offenders).toEqual([]);
  });

  it('is turned on for test wherever its D1 is bound', () => {
    for (const c of configs) {
      const testBlocks = c.blocks.filter((b) => b.section === 'env.test' || b.section.startsWith('env.test.'));
      const bound = testBlocks.some((b) => b.values.get('binding') === 'DNS_SANDBOX');
      const mode = testBlocks.find((b) => b.values.has('WELDHOST_DNS_MODE'))?.values.get('WELDHOST_DNS_MODE');
      expect(mode, `${c.file}: WELDHOST_DNS_MODE without DNS_SANDBOX`).toBe(bound ? 'sandbox' : undefined);
    }
  });
});
