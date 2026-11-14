/**
 * PanelProject: one per project, SQLite storage, in the EU jurisdiction
 * (ADR PANEL-004, weldsuite-documentation/plans/weldpanel.md "Durable Objects"). It holds what
 * is mutable, searchable and erasable about the project's visitors:
 *
 *   people      the profiles (`$email`, `$name`, custom properties)
 *   identities  anonymous id → user id links
 *   erased      ids erased but not yet rewritten out of Iceberg (queries exclude them)
 *   live        sessions seen in the last five minutes, for the live view
 *
 * The collector calls `identify`, `applyPeopleOps` and `touchLive`; panel-api
 * reaches the same class (a binding with `script_name`) for the read and
 * erase side. Every call goes through `projectObjectStub`, which pins the EU
 * jurisdiction: an id made without it names a different, empty object.
 *
 * A link or a profile change also writes a row to `identities_v1` / `people_v1`
 * (`PANEL_IDENTITIES` / `PANEL_PEOPLE`), so reports can join on them. A missing
 * stream is one warning and no row, never an error: the object's own state is
 * the source of truth.
 *
 * One object holds all of a project's people. If a project outgrows that,
 * people and identities shard by hash of the id (the plan's "Scaling" note);
 * the live view and the erased list stay in one.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  PanelErasure,
  PanelLiveSession,
  PanelLiveTouch,
  PanelPeopleOp,
  PanelPeoplePage,
  PanelPerson,
  PanelProjectObjectApi,
  PanelPropertyValue,
} from '@weldsuite/panel-domain/project-object';
import type { PanelIdentityRecord, PanelPersonRecord } from '@weldsuite/panel-domain/tables';
import type { Env } from '../env';
import { warnOnce } from '../lib/warn';

const LIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_LIVE_SESSIONS = 2000;
const LIVE_SESSIONS_RETURNED = 500;
const MAX_PROFILE_PROPERTIES = 200;
const MAX_PROFILE_BYTES = 32 * 1024;
const MAX_EMAIL = 320;
const MAX_PAGE = 200;
/** A key that would set a prototype instead of a property. */
const FORBIDDEN_KEYS = new Set(['__proto__']);

type Props = Record<string, PanelPropertyValue>;

type PersonRow = {
  user_id: string;
  email: string | null;
  name: string | null;
  properties: string;
  first_seen: string;
  last_seen: string;
};
type IdentityRow = { anon_id: string; user_id: string; ts: string };
type LiveRow = {
  session_id: string;
  distinct_id: string;
  path: string;
  title: string | null;
  country: string | null;
  device_type: 'desktop' | 'mobile' | 'tablet' | null;
  started_at: string;
  ts: string;
  pageviews: number;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
     user_id TEXT PRIMARY KEY,
     email TEXT,
     name TEXT,
     properties TEXT NOT NULL,
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS people_email ON people (email)',
  'CREATE INDEX IF NOT EXISTS people_last_seen ON people (last_seen DESC, user_id DESC)',
  `CREATE TABLE IF NOT EXISTS identities (
     anon_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     ts TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)',
  'CREATE TABLE IF NOT EXISTS erased (id TEXT PRIMARY KEY, ts TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS live (
     session_id TEXT PRIMARY KEY,
     distinct_id TEXT NOT NULL,
     path TEXT NOT NULL,
     title TEXT,
     country TEXT,
     device_type TEXT,
     started_at TEXT NOT NULL,
     ts TEXT NOT NULL,
     pageviews INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS live_ts ON live (ts)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
];

function parseProps(text: string): Props {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (Object.assign(Object.create(null), value) as Props) : (Object.create(null) as Props);
  } catch {
    return Object.create(null) as Props;
  }
}

/** `$email` is kept trimmed and lower-cased so lookups by email are exact. Anything else but a short string is dropped. */
function normalise(key: string, value: PanelPropertyValue): PanelPropertyValue | undefined {
  if (key !== '$email') return value;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= MAX_EMAIL ? email : undefined;
}

/** Applies one operation to a profile's properties in place. */
function applyOp(props: Props, op: PanelPeopleOp): void {
  const assign = (key: string, value: PanelPropertyValue, onlyIfMissing: boolean) => {
    if (FORBIDDEN_KEYS.has(key)) return;
    if (onlyIfMissing && key in props) return;
    if (!(key in props) && Object.keys(props).length >= MAX_PROFILE_PROPERTIES) return;
    const normalised = normalise(key, value);
    if (normalised === undefined) return;
    props[key] = normalised;
  };

  switch (op.op) {
    case 'set':
      for (const [key, value] of Object.entries(op.props)) assign(key, value, false);
      return;
    case 'set_once':
      for (const [key, value] of Object.entries(op.props)) assign(key, value, true);
      return;
    case 'unset':
      for (const key of op.keys) delete props[key];
      return;
    case 'increment':
      for (const [key, by] of Object.entries(op.props)) {
        if (FORBIDDEN_KEYS.has(key) || !Number.isFinite(by)) continue;
        const current = props[key];
        assign(key, (typeof current === 'number' ? current : 0) + by, false);
      }
      return;
  }
}

function emailOf(props: Props): string | null {
  const value = props.$email;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nameOf(props: Props): string | null {
  const value = props.$name;
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 255) : null;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function encodeCursor(lastSeen: string, userId: string): string {
  return btoa(encodeURIComponent(JSON.stringify([lastSeen, userId])));
}

function decodeCursor(cursor: string | null | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
    return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string' ? [value[0], value[1]] : null;
  } catch {
    return null;
  }
}

export class PanelProject extends DurableObject<Env> implements PanelProjectObjectApi {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
  }

  // --- storage helpers ----------------------------------------------------

  private all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  private run(query: string, ...bindings: SqlStorageValue[]): void {
    this.ctx.storage.sql.exec(query, ...bindings);
  }

  private personRow(userId: string): PersonRow | undefined {
    return this.all<PersonRow>('SELECT * FROM people WHERE user_id = ?', userId)[0];
  }

  private isErased(id: string): boolean {
    return this.all<{ id: string }>('SELECT id FROM erased WHERE id = ?', id).length > 0;
  }

  /** The next value of the object's change counter: every profile change takes a higher number than any before it. */
  private nextVersion(): number {
    const row = this.all<{ value: number }>(
      `INSERT INTO meta (key, value) VALUES ('version', 1)
       ON CONFLICT (key) DO UPDATE SET value = value + 1
       RETURNING value`,
    )[0];
    return row?.value ?? 1;
  }

  private toPerson(row: PersonRow): PanelPerson {
    const anonIds = this.all<{ anon_id: string }>('SELECT anon_id FROM identities WHERE user_id = ? ORDER BY ts, anon_id', row.user_id);
    return {
      userId: row.user_id,
      email: row.email,
      name: row.name,
      properties: parseProps(row.properties),
      anonIds: anonIds.map((link) => link.anon_id),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  }

  private snapshot(workspaceId: string, projectId: string, userId: string, version: number, ts: string, props: Props, deleted: boolean): PanelPersonRecord {
    return {
      workspace_id: workspaceId,
      project_id: projectId,
      user_id: userId,
      version,
      ts,
      properties: JSON.stringify(deleted ? {} : props),
      deleted,
    };
  }

  /** Rows go to their stream after the state is saved; a missing or failing stream never undoes it. */
  private async emit<T>(stream: { send(records: T[]): Promise<void> } | undefined, table: string, rows: T[]): Promise<void> {
    if (rows.length === 0) return;
    if (!stream) {
      warnOnce(`stream:${table}`, `The ${table} stream is not bound: its rows are not written`);
      return;
    }
    try {
      await stream.send(rows);
    } catch (error) {
      console.error(`[panel-ingest] ${table} write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- collector side -----------------------------------------------------

  async identify(input: { workspaceId: string; projectId: string; anonId: string; userId: string; ts: string }): Promise<{ linked: boolean }> {
    const { workspaceId, projectId, anonId, userId, ts } = input;
    if (!anonId || !userId) return { linked: false };

    let linked = false;
    let identityRow: PanelIdentityRecord | null = null;
    let personRecord: PanelPersonRecord | null = null;
    const now = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      if (this.isErased(anonId) || this.isErased(userId)) return;

      const existing = this.all<IdentityRow>('SELECT * FROM identities WHERE anon_id = ?', anonId)[0];
      if (existing) {
        // The first link wins: an anonymous id never moves to another user.
        linked = existing.user_id === userId;
      } else {
        this.run('INSERT INTO identities (anon_id, user_id, ts) VALUES (?, ?, ?)', anonId, userId, ts);
        identityRow = { workspace_id: workspaceId, project_id: projectId, anon_id: anonId, user_id: userId, ts };
        linked = true;
      }
      if (!linked) return;

      if (this.personRow(userId)) {
        this.run('UPDATE people SET last_seen = ? WHERE user_id = ?', now, userId);
      } else {
        const props: Props = Object.assign(Object.create(null) as Props, { $created: ts });
        this.run(
          'INSERT INTO people (user_id, email, name, properties, first_seen, last_seen) VALUES (?, NULL, NULL, ?, ?, ?)',
          userId,
          JSON.stringify(props),
          now,
          now,
        );
        personRecord = this.snapshot(workspaceId, projectId, userId, this.nextVersion(), now, props, false);
      }
    });

    await Promise.all([
      this.emit(this.env.PANEL_IDENTITIES, 'identities_v1', identityRow ? [identityRow] : []),
      this.emit(this.env.PANEL_PEOPLE, 'people_v1', personRecord ? [personRecord] : []),
    ]);
    return { linked };
  }

  async applyPeopleOps(input: { workspaceId: string; projectId: string; ops: PanelPeopleOp[] }): Promise<void> {
    const { workspaceId, projectId, ops } = input;
    // One row per profile and call: the state after the last of its operations.
    const changed = new Map<string, PanelPersonRecord>();
    const now = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      for (const op of ops) {
        if (!op.userId || this.isErased(op.userId)) continue;

        const existing = this.personRow(op.userId);
        const props = existing ? parseProps(existing.properties) : (Object.assign(Object.create(null), { $created: op.ts }) as Props);
        const before = JSON.stringify(props);
        applyOp(props, op);
        const after = JSON.stringify(props);
        if (after.length > MAX_PROFILE_BYTES) continue;

        if (existing && before === after) {
          this.run('UPDATE people SET last_seen = ? WHERE user_id = ?', now, op.userId);
          continue;
        }
        if (existing) {
          this.run('UPDATE people SET email = ?, name = ?, properties = ?, last_seen = ? WHERE user_id = ?', emailOf(props), nameOf(props), after, now, op.userId);
        } else {
          this.run(
            'INSERT INTO people (user_id, email, name, properties, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
            op.userId,
            emailOf(props),
            nameOf(props),
            after,
            now,
            now,
          );
        }
        changed.set(op.userId, this.snapshot(workspaceId, projectId, op.userId, this.nextVersion(), now, props, false));
      }
    });

    await this.emit(this.env.PANEL_PEOPLE, 'people_v1', [...changed.values()]);
  }

  async touchLive(touches: PanelLiveTouch[]): Promise<void> {
    if (touches.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const touch of touches) {
        if (this.isErased(touch.distinctId) || this.isErased(touch.sessionId)) continue;

        const existing = this.all<LiveRow>('SELECT * FROM live WHERE session_id = ?', touch.sessionId)[0];
        if (!existing) {
          this.run(
            'INSERT INTO live (session_id, distinct_id, path, title, country, device_type, started_at, ts, pageviews) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
            touch.sessionId,
            touch.distinctId,
            touch.path,
            touch.title,
            touch.country,
            touch.deviceType,
            touch.ts,
            touch.ts,
          );
          continue;
        }
        // A new path is a new page view; the same path is the visitor still being there.
        this.run(
          'UPDATE live SET distinct_id = ?, path = ?, title = ?, country = ?, device_type = ?, ts = MAX(ts, ?), pageviews = pageviews + ? WHERE session_id = ?',
          touch.distinctId,
          touch.path,
          touch.title,
          touch.country,
          touch.deviceType,
          touch.ts,
          touch.path === existing.path ? 0 : 1,
          touch.sessionId,
        );
      }
      this.run(`DELETE FROM live WHERE session_id IN (SELECT session_id FROM live ORDER BY ts DESC LIMIT -1 OFFSET ${MAX_LIVE_SESSIONS})`);
    });
    await this.scheduleLiveCleanup();
  }

  private async scheduleLiveCleanup(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LIVE_WINDOW_MS + 1000);
  }

  /** Drops sessions older than five minutes; goes on while any is left. */
  async alarm(): Promise<void> {
    this.run('DELETE FROM live WHERE ts < ?', new Date(Date.now() - LIVE_WINDOW_MS).toISOString());
    const left = this.all<{ n: number }>('SELECT COUNT(*) AS n FROM live')[0]?.n ?? 0;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + LIVE_WINDOW_MS);
  }

  // --- panel-api side -----------------------------------------------------

  async getPerson(userIdOrAnonId: string): Promise<PanelPerson | null> {
    const direct = this.personRow(userIdOrAnonId);
    if (direct) return this.toPerson(direct);
    const link = this.all<IdentityRow>('SELECT * FROM identities WHERE anon_id = ?', userIdOrAnonId)[0];
    const linked = link ? this.personRow(link.user_id) : undefined;
    return linked ? this.toPerson(linked) : null;
  }

  async listPeople(input: { search?: string; cursor?: string | null; limit: number }): Promise<PanelPeoplePage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), MAX_PAGE);
    const conditions: string[] = [];
    const bindings: SqlStorageValue[] = [];

    const search = input.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      conditions.push("(user_id LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
      bindings.push(like, like, like);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalCount = this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM people ${where}`, ...bindings)[0]?.n ?? 0;

    const after = decodeCursor(input.cursor);
    const pageConditions = [...conditions];
    const pageBindings = [...bindings];
    if (after) {
      pageConditions.push('(last_seen < ? OR (last_seen = ? AND user_id < ?))');
      pageBindings.push(after[0], after[0], after[1]);
    }
    const pageWhere = pageConditions.length > 0 ? `WHERE ${pageConditions.join(' AND ')}` : '';
    const rows = this.all<PersonRow>(
      `SELECT * FROM people ${pageWhere} ORDER BY last_seen DESC, user_id DESC LIMIT ?`,
      ...pageBindings,
      limit + 1,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      people: page.map((row) => this.toPerson(row)),
      cursor: hasMore && last ? encodeCursor(last.last_seen, last.user_id) : null,
      totalCount,
    };
  }

  async findByEmail(email: string): Promise<PanelPerson[]> {
    const rows = this.all<PersonRow>('SELECT * FROM people WHERE email = ? ORDER BY last_seen DESC LIMIT 50', email.trim().toLowerCase());
    return rows.map((row) => this.toPerson(row));
  }

  async live(): Promise<{ visitors: number; sessions: PanelLiveSession[] }> {
    const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
    const visitors = this.all<{ n: number }>('SELECT COUNT(DISTINCT distinct_id) AS n FROM live WHERE ts >= ?', since)[0]?.n ?? 0;
    const rows = this.all<LiveRow>('SELECT * FROM live WHERE ts >= ? ORDER BY ts DESC LIMIT ?', since, LIVE_SESSIONS_RETURNED);
    return {
      visitors,
      sessions: rows.map((row) => ({
        sessionId: row.session_id,
        distinctId: row.distinct_id,
        path: row.path,
        title: row.title,
        country: row.country,
        deviceType: row.device_type,
        ts: row.ts,
        startedAt: row.started_at,
        pageviews: row.pageviews,
      })),
    };
  }

  async erase(input: { workspaceId: string; projectId: string; userIdOrAnonId: string }): Promise<PanelErasure> {
    const { workspaceId, projectId, userIdOrAnonId: given } = input;
    const now = new Date().toISOString();
    let result: PanelErasure = { userId: null, erasedIds: [given] };
    let deletedRow: PanelPersonRecord | null = null;

    this.ctx.storage.transactionSync(() => {
      // The id may name a user, or an anonymous id that resolves to one.
      let userId: string | null = null;
      if (this.personRow(given)) {
        userId = given;
      } else {
        const link = this.all<IdentityRow>('SELECT * FROM identities WHERE anon_id = ?', given)[0];
        if (link) userId = link.user_id;
        else if (this.all<IdentityRow>('SELECT * FROM identities WHERE user_id = ? LIMIT 1', given).length > 0) userId = given;
      }

      const ids = new Set<string>([given]);
      if (userId) {
        ids.add(userId);
        for (const link of this.all<{ anon_id: string }>('SELECT anon_id FROM identities WHERE user_id = ?', userId)) ids.add(link.anon_id);
        this.run('DELETE FROM people WHERE user_id = ?', userId);
        this.run('DELETE FROM identities WHERE user_id = ?', userId);
      }
      for (const id of ids) {
        this.run('DELETE FROM live WHERE distinct_id = ? OR session_id = ?', id, id);
        this.run('INSERT OR IGNORE INTO erased (id, ts) VALUES (?, ?)', id, now);
      }
      if (userId) deletedRow = this.snapshot(workspaceId, projectId, userId, this.nextVersion(), now, Object.create(null) as Props, true);
      result = { userId, erasedIds: [...ids] };
    });

    await this.emit(this.env.PANEL_PEOPLE, 'people_v1', deletedRow ? [deletedRow] : []);
    return result;
  }

  async erasedIds(): Promise<string[]> {
    return this.all<{ id: string }>('SELECT id FROM erased ORDER BY id').map((row) => row.id);
  }

  async hasIdentifiedUsers(): Promise<boolean> {
    return this.all<{ one: number }>('SELECT 1 AS one FROM identities LIMIT 1').length > 0;
  }

  async clearErased(ids: string[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) this.run('DELETE FROM erased WHERE id = ?', id);
    });
  }
}
