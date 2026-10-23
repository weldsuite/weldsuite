/**
 * Storage for the DNS sandbox: zones and records as JSON documents.
 *
 * D1 in the test environment (binding `DNS_SANDBOX`), memory in unit tests.
 * D1 rather than KV because the record sync reads a zone right after writing
 * it, and KV only promises eventual consistency.
 */

export interface SandboxZone {
  id: string;
  name: string;
  account: { id: string; name: string };
  status: 'pending' | 'active';
  name_servers: string[];
  original_name_servers: string[] | null;
  type: 'full';
  paused: boolean;
  created_on: string;
  modified_on: string;
  activated_on: string | null;
}

export interface SandboxRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  type: string;
  name: string;
  content?: string;
  data?: Record<string, unknown>;
  priority?: number;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  comment: string | null;
  tags: string[];
  created_on: string;
  modified_on: string;
}

export interface SandboxStore {
  getZone(id: string): Promise<SandboxZone | null>;
  findZoneByName(name: string): Promise<SandboxZone | null>;
  /** Insert or replace. */
  putZone(zone: SandboxZone): Promise<void>;
  /** Also deletes the zone's records. */
  deleteZone(id: string): Promise<void>;
  listRecords(zoneId: string): Promise<SandboxRecord[]>;
  getRecord(zoneId: string, id: string): Promise<SandboxRecord | null>;
  /** Insert or replace. */
  putRecord(record: SandboxRecord): Promise<void>;
  deleteRecord(zoneId: string, id: string): Promise<void>;
}

export function memorySandboxStore(): SandboxStore {
  const zones = new Map<string, SandboxZone>();
  const records = new Map<string, SandboxRecord>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    async getZone(id) {
      const z = zones.get(id);
      return z ? clone(z) : null;
    },
    async findZoneByName(name) {
      const z = [...zones.values()].find((zone) => zone.name === name);
      return z ? clone(z) : null;
    },
    async putZone(zone) {
      zones.set(zone.id, clone(zone));
    },
    async deleteZone(id) {
      zones.delete(id);
      for (const [rid, r] of records) if (r.zone_id === id) records.delete(rid);
    },
    async listRecords(zoneId) {
      return [...records.values()].filter((r) => r.zone_id === zoneId).map(clone);
    },
    async getRecord(zoneId, id) {
      const r = records.get(id);
      return r && r.zone_id === zoneId ? clone(r) : null;
    },
    async putRecord(record) {
      records.set(record.id, clone(record));
    },
    async deleteRecord(zoneId, id) {
      if (records.get(id)?.zone_id === zoneId) records.delete(id);
    },
  };
}

/** The slice of the D1 binding the store uses, so this package needs no workers-types. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sandbox_zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sandbox_dns_records (
    id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL,
    body TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sandbox_dns_records_zone ON sandbox_dns_records (zone_id)',
];

/**
 * The tables are created on first use instead of through a migration: the
 * sandbox exists only on test, and this keeps it out of the deploy pipeline.
 */
const schemaReady = new WeakMap<D1Like, Promise<void>>();

function ensureSchema(db: D1Like): Promise<void> {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = db
      .batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((err: unknown) => {
        schemaReady.delete(db);
        throw err;
      });
    schemaReady.set(db, ready);
  }
  return ready;
}

function parse<T>(row: { body: string } | null): T | null {
  return row ? (JSON.parse(row.body) as T) : null;
}

export function d1SandboxStore(db: D1Like): SandboxStore {
  const q = async (sql: string, ...values: unknown[]) => {
    await ensureSchema(db);
    return db.prepare(sql).bind(...values);
  };
  return {
    async getZone(id) {
      return parse<SandboxZone>(await (await q('SELECT body FROM sandbox_zones WHERE id = ?', id)).first());
    },
    async findZoneByName(name) {
      return parse<SandboxZone>(await (await q('SELECT body FROM sandbox_zones WHERE name = ?', name)).first());
    },
    async putZone(zone) {
      await (
        await q(
          'INSERT OR REPLACE INTO sandbox_zones (id, name, body) VALUES (?, ?, ?)',
          zone.id,
          zone.name,
          JSON.stringify(zone),
        )
      ).run();
    },
    async deleteZone(id) {
      await ensureSchema(db);
      await db.batch([
        db.prepare('DELETE FROM sandbox_dns_records WHERE zone_id = ?').bind(id),
        db.prepare('DELETE FROM sandbox_zones WHERE id = ?').bind(id),
      ]);
    },
    async listRecords(zoneId) {
      const { results } = await (
        await q('SELECT body FROM sandbox_dns_records WHERE zone_id = ? ORDER BY id', zoneId)
      ).all<{ body: string }>();
      return results.map((r) => JSON.parse(r.body) as SandboxRecord);
    },
    async getRecord(zoneId, id) {
      return parse<SandboxRecord>(
        await (await q('SELECT body FROM sandbox_dns_records WHERE zone_id = ? AND id = ?', zoneId, id)).first(),
      );
    },
    async putRecord(record) {
      await (
        await q(
          'INSERT OR REPLACE INTO sandbox_dns_records (id, zone_id, body) VALUES (?, ?, ?)',
          record.id,
          record.zone_id,
          JSON.stringify(record),
        )
      ).run();
    },
    async deleteRecord(zoneId, id) {
      await (await q('DELETE FROM sandbox_dns_records WHERE zone_id = ? AND id = ?', zoneId, id)).run();
    },
  };
}
