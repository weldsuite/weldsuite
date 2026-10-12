import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_MODULES,
  createApiOriginResolver,
  findModuleForExternalPath,
  findModuleForPath,
  getApiModule,
  missingLicensedApp,
  MODULE_WORKERS,
  moduleOriginFrom,
  coreOriginFrom,
  originForPathFrom,
  parseModuleList,
} from './index';

const WORKERS_DIR = path.resolve(__dirname, '../../../../apps/workers');

/** Every `app.route('/api/...')` / `app.route('/public/...')` mount in a worker entry. */
function mountedPrefixes(entryFile: string): string[] {
  // Ignore commented-out mounts (examples in comments are not routes).
  const source = readFileSync(entryFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const prefixes = new Set<string>();
  for (const match of source.matchAll(/app\.route\(\s*'((?:\/api|\/public|\/webhooks)\/[^'*]+)'/g)) {
    prefixes.add(match[1]!);
  }
  return [...prefixes];
}

function workerEntry(worker: string): string | null {
  const file = path.join(WORKERS_DIR, worker, 'src', 'index.ts');
  return existsSync(file) ? file : null;
}

describe('manifest shape', () => {
  it('has unique ids, workers, bindings and dev ports', () => {
    for (const key of ['id', 'worker', 'binding', 'devPort'] as const) {
      const values = API_MODULES.map((m) => m[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it('never assigns a prefix to two modules', () => {
    const seen = new Map<string, string>();
    for (const m of API_MODULES) {
      for (const prefix of m.prefixes) {
        expect(seen.get(prefix), `${prefix} is owned by ${seen.get(prefix)} and ${m.id}`).toBeUndefined();
        seen.set(prefix, m.id);
      }
    }
  });

  it('only uses clean prefixes', () => {
    for (const m of API_MODULES) {
      for (const prefix of m.prefixes) {
        expect(prefix, `${m.id}: ${prefix}`).toMatch(/^\/(api|public|webhooks)(\/[a-z0-9-]+)+$/);
      }
    }
  });
});

describe('ownership', () => {
  it('owns every prefix app-api mounts', () => {
    const entry = workerEntry('app-api');
    expect(entry).not.toBeNull();
    const owned = API_MODULES.flatMap((m) => m.prefixes);
    const covered = (p: string) => owned.some((o) => p === o || p.startsWith(`${o}/`));
    const unowned = mountedPrefixes(entry!).filter((p) => !covered(p));
    expect(
      unowned,
      'New app-api mounts must be assigned to a module in packages/core/api-modules/src/index.ts',
    ).toEqual([]);
  });

  it('module workers only mount prefixes of their own module', () => {
    for (const m of API_MODULES) {
      if (m.id === 'core') continue;
      const entry = workerEntry(m.worker);
      if (!entry) continue;
      const foreign = mountedPrefixes(entry).filter((p) => findModuleForPath(p).id !== m.id);
      expect(foreign, `${m.worker} mounts prefixes owned by other modules`).toEqual([]);
    }
  });
});

describe('worker boundaries', () => {
  const workerDirs = readdirSync(WORKERS_DIR).filter((d) =>
    statSync(path.join(WORKERS_DIR, d)).isDirectory(),
  );
  const moduleWorkers = new Set(API_MODULES.map((m) => m.worker));

  function sourceFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('node_modules'))
      .map((f) => path.join(dir, f));
  }

  it('API workers never import from another worker folder', () => {
    const violations: string[] = [];
    for (const worker of workerDirs.filter((d) => moduleWorkers.has(d))) {
      const root = path.join(WORKERS_DIR, worker);
      for (const file of sourceFiles(path.join(root, 'src'))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
          const target = path.resolve(path.dirname(file), match[1]!);
          if (!target.startsWith(root + path.sep)) {
            violations.push(`${path.relative(WORKERS_DIR, file)} → ${match[1]}`);
          }
        }
      }
    }
    expect(violations, 'Share code through a package (e.g. @weldsuite/worker-kit), not a relative import').toEqual([]);
  });
});

describe('findModuleForPath', () => {
  it('matches whole segments and prefers the longest prefix', () => {
    expect(findModuleForPath('/api/tickets').id).toBe('desk');
    expect(findModuleForPath('/api/tickets/tkt_1/messages').id).toBe('desk');
    expect(findModuleForPath('/api/desk/phone/calls').id).toBe('call');
    expect(findModuleForPath('/api/internal/telephony/fulfill-number').id).toBe('call');
    expect(findModuleForPath('/api/internal/workflow-actions/create-customer').id).toBe('connect');
    expect(findModuleForPath('/api/internal/send-email').id).toBe('core');
    expect(findModuleForPath('/api/desk/conversations').id).toBe('desk');
    expect(findModuleForPath('/api/integrations/helpdesk/discord').id).toBe('desk');
    expect(findModuleForPath('/api/integrations/connections/1/sync').id).toBe('connect');
    expect(findModuleForPath('/api/weldpass?x=1').id).toBe('pass');
  });

  it('falls back to core for unknown paths', () => {
    expect(findModuleForPath('/api/tasks-archive').id).toBe('core');
    expect(findModuleForPath('/health').id).toBe('core');
  });
});

describe('origins', () => {
  const pass = getApiModule('pass');

  it('derives module hosts from the app-api host', () => {
    expect(moduleOriginFrom('https://app-api.weldsuite.org', pass)).toBe('https://pass-api.weldsuite.org');
    expect(moduleOriginFrom('https://app-api-test.weldsuite.org', pass)).toBe(
      'https://pass-api-test.weldsuite.org',
    );
    expect(moduleOriginFrom('http://localhost:8789', pass)).toBe('http://localhost:8820');
  });

  it('leaves hosts it cannot map alone', () => {
    expect(moduleOriginFrom('https://proxy.example.com', pass)).toBe('https://proxy.example.com');
    expect(coreOriginFrom('https://proxy.example.com')).toBe('https://proxy.example.com');
  });

  it('maps any worker host back to app-api', () => {
    expect(coreOriginFrom('https://crm-api-test.weldsuite.org')).toBe('https://app-api-test.weldsuite.org');
    expect(coreOriginFrom('https://connect-api.weldsuite.org')).toBe('https://app-api.weldsuite.org');
    expect(coreOriginFrom('https://app-api.weldsuite.org')).toBe('https://app-api.weldsuite.org');
    expect(coreOriginFrom('http://localhost:8801')).toBe('http://localhost:8789');
  });

  it('points callback URLs at the worker that owns the path', () => {
    expect(originForPathFrom('https://connect-api.weldsuite.org', '/webhooks/woocommerce/auth')).toBe(
      'https://commerce-api.weldsuite.org',
    );
    expect(originForPathFrom('https://app-api-test.weldsuite.org', '/webhooks/woocommerce/auth')).toBe(
      'https://commerce-api-test.weldsuite.org',
    );
    expect(originForPathFrom('https://crm-api.weldsuite.org', '/api/workspaces')).toBe(
      'https://app-api.weldsuite.org',
    );
  });

  it('parses module lists, dropping core and unknown ids', () => {
    expect([...parseModuleList(' pass, host ,core,nope,')]).toEqual(['pass', 'host']);
    expect(parseModuleList(undefined).size).toBe(0);
  });

  it('expands all, minus exclusions', () => {
    const all = parseModuleList('all');
    expect(all.size).toBe(API_MODULES.length - 1);
    expect(all.has('core' as never)).toBe(false);
    const most = parseModuleList(' all , -connect,-nope');
    expect(most.size).toBe(API_MODULES.length - 2);
    expect(most.has('connect')).toBe(false);
    expect([...parseModuleList('-pass,pass')]).toEqual([]);
  });

  it('routes only enabled modules to their own host', () => {
    const resolver = createApiOriginResolver({
      coreOrigin: 'https://app-api.weldsuite.org/',
      enabled: new Set(['pass']),
      overrides: {},
    });
    expect(resolver.originForPath('/api/weldpass/projects')).toBe('https://pass-api.weldsuite.org');
    expect(resolver.originForPath('/api/tickets')).toBe('https://app-api.weldsuite.org');
    expect(resolver.allOrigins()).toEqual(['https://app-api.weldsuite.org', 'https://pass-api.weldsuite.org']);
  });

  it('honours explicit overrides', () => {
    const resolver = createApiOriginResolver({
      coreOrigin: 'http://localhost:8789',
      enabled: new Set(['pass']),
      overrides: { pass: 'http://127.0.0.1:9999/' },
    });
    expect(resolver.originForPath('/api/weldpass')).toBe('http://127.0.0.1:9999');
  });
});

describe('licence gate lookups', () => {
  const licensed = (...apps: string[]) => new Set(apps);

  it('never gates core or WeldAgent, and names an owning app for every other module', () => {
    expect(getApiModule('core').apps).toBeNull();
    expect(getApiModule('agent').apps).toBeNull();
    for (const m of MODULE_WORKERS.filter((w) => w.id !== 'agent')) {
      expect(m.apps?.length, m.id).toBeGreaterThan(0);
      expect(new Set(m.apps).size, `${m.id} lists an app twice`).toBe(m.apps!.length);
    }
  });

  it('lets a module through when any app that reads it is licensed', () => {
    const deskOnly = licensed('welddesk');
    expect(missingLicensedApp(findModuleForPath('/api/tickets/1'), deskOnly)).toBeNull();
    // WeldDesk screens read CRM companies and people.
    expect(missingLicensedApp(findModuleForPath('/api/companies'), deskOnly)).toBeNull();
    expect(missingLicensedApp(findModuleForPath('/api/settings/profile'), deskOnly)).toBeNull();
    expect(missingLicensedApp(findModuleForPath('/api/ai/chat'), deskOnly)).toBeNull();
  });

  it("names the module's own app when nothing that reads it is licensed", () => {
    const deskOnly = licensed('welddesk');
    expect(missingLicensedApp(findModuleForPath('/api/invoices'), deskOnly)).toBe('weldbooks');
    expect(missingLicensedApp(findModuleForPath('/api/weldpass/vaults'), deskOnly)).toBe('weldpass');
    expect(missingLicensedApp(findModuleForPath('/api/tickets'), licensed())).toBe('welddesk');
  });

  it('maps external-api paths onto the first-party module', () => {
    expect(findModuleForExternalPath('/v1/tickets/123').id).toBe('desk');
    expect(findModuleForExternalPath('/v1/mail-accounts/a1/send').id).toBe('mail');
    expect(findModuleForExternalPath('/v1/knowledge-pages').id).toBe('know');
    expect(findModuleForExternalPath('/v1/quotes?limit=5').id).toBe('crm');
    expect(findModuleForExternalPath('/v1/files').id).toBe('core');
    expect(findModuleForExternalPath('/v1').id).toBe('core');
    expect(findModuleForExternalPath('/health').id).toBe('core');
  });

  it('places every external-api object in a module, or in the known core list', () => {
    // Objects external-api serves that genuinely belong to the core platform.
    // Anything else falling through to core would silently escape the gate.
    const coreObjects = new Set([
      'app-storage', 'custom-objects', 'drive', 'files', 'folders', 'settings', 'user-apps', 'webhooks',
    ]);
    const source = readFileSync(path.resolve(WORKERS_DIR, 'external-api/src/routes/v1/index.ts'), 'utf8');
    const objects = [...source.matchAll(/v1\.route\(\s*'\/([^'/]+)'/g)].map((m) => m[1]!);
    expect(objects.length).toBeGreaterThan(50);
    const escaped = objects.filter(
      (o) => findModuleForExternalPath(`/v1/${o}`).id === 'core' && !coreObjects.has(o),
    );
    expect(escaped).toEqual([]);
  });
});
