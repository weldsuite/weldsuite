/**
 * The raw-export reader (./export): isolation like every compiled query
 * (workspace, project and time window from the context, erased people left
 * out), values only ever as literals, and keyset paging that neither skips nor
 * repeats rows that share a second.
 */

import { describe, expect, it } from 'vitest';
import type { PanelQueryContext } from './context';
import {
  PANEL_EXPORT_PAGE_SIZE,
  PANEL_EXPORT_TABLE_NAMES,
  exactTimestamp,
  exportColumns,
  exportCursorOf,
  exportPageQuery,
} from './export';
import { PanelQueryError } from './sql';

const ctx = (overrides: Partial<PanelQueryContext> = {}): PanelQueryContext => ({
  workspaceId: 'ws_1',
  projectId: 'pnp_1',
  retentionDays: 365,
  hasIdentifiedUsers: true,
  erasedIds: [],
  now: new Date('2026-11-14T12:00:00Z'),
  ...overrides,
});

const FROM = new Date('2026-11-14T10:00:00Z');
const TO = new Date('2026-11-14T11:00:00Z');

describe('isolation', () => {
  it.each(PANEL_EXPORT_TABLE_NAMES)('%s: scoped to the workspace, the project and the window', (table) => {
    const { sql, columns } = exportPageQuery(ctx(), { table, from: FROM, to: TO });
    expect(sql).toContain("workspace_id = 'ws_1'");
    expect(sql).toContain("project_id = 'pnp_1'");
    expect(sql).toContain("TIMESTAMP '2026-11-14 10:00:00.000'");
    expect(sql).toContain("TIMESTAMP '2026-11-14 11:00:00.000'");
    expect(sql).toMatch(new RegExp(`FROM panel\\.${table === 'events' ? 'events' : table}_v1 `));
    expect(sql).toContain(`LIMIT ${PANEL_EXPORT_PAGE_SIZE}`);
    expect(sql).not.toMatch(/OFFSET/i);
    // The workspace is never exported as a column.
    expect(columns).not.toContain('workspace_id');
    expect(columns).toEqual(exportColumns(table));
  });

  it('reads events by arrival, the other tables by their own time', () => {
    expect(exportPageQuery(ctx(), { table: 'events', from: FROM, to: TO }).sql).toMatch(/received_at >= .* AND received_at < /);
    expect(exportPageQuery(ctx(), { table: 'people', from: FROM, to: TO }).sql).toMatch(/ts >= .* AND ts < /);
  });

  it('leaves erased people out of events, people and identities', () => {
    const erased = ctx({ erasedIds: ['user_gone', 'anon_gone', 'user_gone'] });
    const events = exportPageQuery(erased, { table: 'events', from: FROM, to: TO }).sql;
    expect(events).toContain("anon_id NOT IN ('user_gone', 'anon_gone')");
    expect(events).toContain("distinct_id NOT IN ('user_gone', 'anon_gone')");
    expect(events).toContain("COALESCE(user_id, '') NOT IN ('user_gone', 'anon_gone')");
    expect(exportPageQuery(erased, { table: 'people', from: FROM, to: TO }).sql).toContain("user_id NOT IN ('user_gone', 'anon_gone')");
    const identities = exportPageQuery(erased, { table: 'identities', from: FROM, to: TO }).sql;
    expect(identities).toContain("anon_id NOT IN ('user_gone', 'anon_gone')");
    expect(identities).toContain("user_id NOT IN ('user_gone', 'anon_gone')");
    expect(exportPageQuery(erased, { table: 'groups', from: FROM, to: TO }).sql).not.toContain('NOT IN');
  });

  it('quotes ids from the context and the cursor, so they cannot break out of a literal', () => {
    const evil = ctx({ workspaceId: "ws' OR '1'='1", erasedIds: ["x') OR (1=1"] });
    const { sql } = exportPageQuery(evil, {
      table: 'events',
      from: FROM,
      to: TO,
      after: { time: '2026-11-14 10:30:00.123456', keys: ["evt' OR 1=1 --"] },
    });
    expect(sql).toContain("workspace_id = 'ws'' OR ''1''=''1'");
    expect(sql).toContain("'x'') OR (1=1'");
    expect(sql).toContain("event_id > 'evt'' OR 1=1 --'");
  });

  it('refuses a window over an hour, an empty one, and too many erasures', () => {
    expect(() => exportPageQuery(ctx(), { table: 'events', from: FROM, to: new Date(FROM.getTime() + 3_600_001) })).toThrow(PanelQueryError);
    expect(() => exportPageQuery(ctx(), { table: 'events', from: FROM, to: FROM })).toThrow(PanelQueryError);
    const many = Array.from({ length: 5001 }, (_, i) => `u${i}`);
    expect(() => exportPageQuery(ctx({ erasedIds: many }), { table: 'people', from: FROM, to: TO })).toThrow(PanelQueryError);
  });
});

describe('keyset paging', () => {
  it('starts after the last row, keeping its fractional seconds', () => {
    const last = { received_at: '2026-11-14T10:30:00.123456Z', event_id: 'evt_9' };
    const cursor = exportCursorOf('events', last);
    expect(cursor).toEqual({ time: '2026-11-14T10:30:00.123456Z', keys: ['evt_9'] });
    const { sql } = exportPageQuery(ctx(), { table: 'events', from: FROM, to: TO, after: cursor });
    expect(sql).toContain(
      "(received_at > TIMESTAMP '2026-11-14 10:30:00.123456' OR (received_at = TIMESTAMP '2026-11-14 10:30:00.123456' AND event_id > 'evt_9'))",
    );
    expect(sql).toContain('ORDER BY received_at ASC, event_id ASC');
  });

  it('nests every tie-break column in order, numbers as numbers', () => {
    const cursor = exportCursorOf('groups', { ts: '2026-11-14 10:00:05', group_type: 'company', group_key: 'acme', version: '7' });
    expect(cursor.keys).toEqual(['company', 'acme', 7]);
    const { sql } = exportPageQuery(ctx(), { table: 'groups', from: FROM, to: TO, after: cursor });
    expect(sql).toContain(
      "(ts > TIMESTAMP '2026-11-14 10:00:05' OR (ts = TIMESTAMP '2026-11-14 10:00:05' AND (group_type > 'company' OR (group_type = 'company' AND (group_key > 'acme' OR (group_key = 'acme' AND version > 7))))))",
    );
  });

  it('refuses a cursor that is not a UTC timestamp or does not fit the table', () => {
    expect(() => exportPageQuery(ctx(), { table: 'events', from: FROM, to: TO, after: { time: "2026-11-14'; DROP", keys: ['a'] } })).toThrow(PanelQueryError);
    expect(() => exportPageQuery(ctx(), { table: 'events', from: FROM, to: TO, after: { time: '2026-11-14T10:00:00+02:00', keys: ['a'] } })).toThrow(PanelQueryError);
    expect(() => exportPageQuery(ctx(), { table: 'people', from: FROM, to: TO, after: { time: '2026-11-14T10:00:00Z', keys: ['a'] } })).toThrow(PanelQueryError);
    expect(() => exportPageQuery(ctx(), { table: 'people', from: FROM, to: TO, after: { time: '2026-11-14T10:00:00Z', keys: ['a', Number.NaN] } })).toThrow(PanelQueryError);
  });

  it('writes Dates and epoch millis as exact literals', () => {
    expect(exactTimestamp(new Date('2026-11-14T10:00:00.5Z'))).toBe("TIMESTAMP '2026-11-14 10:00:00.500'");
    expect(exactTimestamp(Date.UTC(2026, 10, 14, 10))).toBe("TIMESTAMP '2026-11-14 10:00:00.000'");
    expect(exactTimestamp('2026-11-14 10:00:00')).toBe("TIMESTAMP '2026-11-14 10:00:00'");
  });
});
