/**
 * Validation messages people see in WeldHR dialogs: readable sentences, not
 * the serialized ZodError the default `zValidator` hook answers with.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHrAttendanceSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import { z } from 'zod';
import { describeIssue, hrJson } from './helpers';

function issuesOf(schema: z.ZodTypeAny, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected the value to fail');
  return result.error.issues;
}

describe('describeIssue', () => {
  it('names the field and the limit', () => {
    const [issue] = issuesOf(z.object({ breakMinutes: z.number().min(0) }), { breakMinutes: -30 });
    expect(describeIssue(issue!)).toBe('Break minutes must be at least 0');
  });

  it('says a required text field is required', () => {
    const [issue] = issuesOf(z.object({ firstName: z.string().min(1) }), { firstName: '' });
    expect(describeIssue(issue!)).toBe('First name is required');
  });

  it('points into arrays by 1-based position', () => {
    const schema = z.object({ scores: z.array(z.object({ score: z.number().min(0) })) });
    const [issue] = issuesOf(schema, { scores: [{ score: 1 }, { score: -1 }] });
    expect(describeIssue(issue!)).toBe('Scores #2 score must be at least 0');
  });

  it('caps a percentage', () => {
    const [issue] = issuesOf(z.object({ allocationPercent: z.number().max(100) }), { allocationPercent: 150 });
    expect(describeIssue(issue!)).toBe('Allocation percent must be at most 100');
  });
});

describe('hrJson', () => {
  it('answers a bad body with the standard envelope and a readable message', async () => {
    const app = new Hono().post('/', hrJson(createHrAttendanceSchema), (c) => c.json({ ok: true }));
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: 'hremp_1', date: '2026-10-08', breakMinutes: -30 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; details: unknown[] } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('Break minutes must be at least 0');
    expect(body.error.details).toHaveLength(1);
  });
});
