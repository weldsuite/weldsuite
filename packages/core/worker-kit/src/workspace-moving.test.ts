/**
 * The "workspace is moving" rules every first-party API, external-api and
 * mcp-server share (TASK-1150): the answer, how the tenant database's own
 * errors are recognised, and the master-query fragment.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WRITE_BLOCKING_DATABASE_MOVE_STATUSES } from '@weldsuite/db/schema/master';
import {
  WORKSPACE_MOVING_RETRY_AFTER_SECONDS,
  classifyMovedDatabaseError,
  databaseMoveInProgressSql,
  workspaceMovingBody,
  workspaceMovingResponse,
} from './workspace-moving';

describe('workspaceMovingBody', () => {
  it('has the WORKSPACE_MOVING shape and nothing else', () => {
    expect(workspaceMovingBody()).toEqual({
      error: {
        code: 'WORKSPACE_MOVING',
        message: 'This workspace is being moved to a new database. Try again in a minute.',
      },
    });
  });
});

describe('workspaceMovingResponse', () => {
  it('is a 503 with the body and Retry-After: 30', async () => {
    expect(WORKSPACE_MOVING_RETRY_AFTER_SECONDS).toBe(30);
    const app = new Hono();
    app.get('/', (c) => workspaceMovingResponse(c));
    const res = await app.request('/');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual(workspaceMovingBody());
  });
});

describe('classifyMovedDatabaseError', () => {
  it('tells a read-only source from a rotated password, and ignores everything else', () => {
    expect(classifyMovedDatabaseError({ code: '25006' })).toBe('read_only');
    expect(classifyMovedDatabaseError({ code: '28P01' })).toBe('password_rotated');
    expect(classifyMovedDatabaseError(new Error("password authentication failed for user 'r'"))).toBe('password_rotated');
    expect(classifyMovedDatabaseError(new Error('cannot execute DELETE in a read-only transaction'))).toBe('read_only');
    expect(classifyMovedDatabaseError(new Error('boom'))).toBeNull();
    expect(classifyMovedDatabaseError({ code: '23505' })).toBeNull();
    expect(classifyMovedDatabaseError(undefined)).toBeNull();
  });
});

describe('databaseMoveInProgressSql', () => {
  const render = () => new PgDialect().sqlToQuery(databaseMoveInProgressSql());

  it('is an EXISTS on this workspace id and the write-blocking statuses', () => {
    const { sql: text, params } = render();
    expect(text).toContain('exists (');
    expect(text).toContain('from "workspace_database_moves"');
    expect(text).toMatch(/"workspace_database_moves"\."workspace_id" = "workspaces"\."id"/);
    expect(text).toMatch(/"workspace_database_moves"\."status" in \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
    expect(params).toEqual([...WRITE_BLOCKING_DATABASE_MOVE_STATUSES]);
    expect(params).toEqual(['soft_locked', 'locked', 'copying', 'verifying', 'switching', 'cancelling']);
  });

  it('decodes true and "t" as moving and everything else, the string "f" included, as not', () => {
    const decode = (databaseMoveInProgressSql() as unknown as { decoder: { mapFromDriverValue: (v: unknown) => unknown } })
      .decoder.mapFromDriverValue;
    expect(decode(true)).toBe(true);
    expect(decode('t')).toBe(true);
    for (const value of [false, 'f', 'false', 0, null, undefined]) {
      expect(decode(value), String(value)).toBe(false);
    }
  });
});
