import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every postgres.js client the module opened, by URL, with its `end` spy. */
const clients: { url: string; end: ReturnType<typeof vi.fn> }[] = [];

vi.mock('postgres', () => ({
  default: (url: string) => {
    const end = vi.fn(async () => {});
    clients.push({ url, end });
    return { url, end };
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: ({ client }: { client: { url: string } }) => ({ url: client.url }),
}));

type Module = typeof import('./database.node');
let db: Module;

beforeEach(async () => {
  vi.resetModules();
  clients.length = 0;
  process.env.ADMIN_TENANT_POOLS = '2';
  db = await import('./database.node');
});

afterEach(() => {
  delete process.env.ADMIN_TENANT_POOLS;
});

const opened = (url: string) => clients.filter((client) => client.url === url);

describe('openTenantDb', () => {
  it('keeps one client per tenant URL', () => {
    const first = db.openTenantDb('postgres://a');
    expect(db.openTenantDb('postgres://a')).toBe(first);
    expect(opened('postgres://a')).toHaveLength(1);
  });

  it('closes the least recently used client past ADMIN_TENANT_POOLS', () => {
    db.openTenantDb('postgres://a');
    db.openTenantDb('postgres://b');
    db.openTenantDb('postgres://a'); // a is now the most recent
    db.openTenantDb('postgres://c');

    expect(opened('postgres://b')[0]!.end).toHaveBeenCalledOnce();
    expect(opened('postgres://a')[0]!.end).not.toHaveBeenCalled();
    expect(opened('postgres://c')[0]!.end).not.toHaveBeenCalled();
  });

  it('opens a closed tenant again when it is asked for', () => {
    db.openTenantDb('postgres://a');
    db.openTenantDb('postgres://b');
    db.openTenantDb('postgres://c');
    db.openTenantDb('postgres://a');
    expect(opened('postgres://a')).toHaveLength(2);
  });
});

describe('openMasterDb', () => {
  it('keeps one client for the master database', () => {
    expect(db.openMasterDb('postgres://master')).toBe(db.openMasterDb('postgres://master'));
    expect(opened('postgres://master')).toHaveLength(1);
  });
});

describe('closeDatabases', () => {
  it('closes the master and every tenant client, and is what node/server.mjs calls on SIGTERM', async () => {
    db.openMasterDb('postgres://master');
    db.openTenantDb('postgres://a');
    db.openTenantDb('postgres://b');

    const shutdown = (globalThis as Record<symbol, unknown>)[Symbol.for('weldsuite.admin.shutdown')];
    expect(shutdown).toBe(db.closeDatabases);
    await db.closeDatabases();

    for (const client of clients) expect(client.end).toHaveBeenCalledOnce();
    db.openTenantDb('postgres://a');
    expect(opened('postgres://a')).toHaveLength(2);
  });
});
