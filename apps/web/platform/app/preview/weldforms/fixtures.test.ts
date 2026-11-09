// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { evaluateSubmission, parseDefinition } from '@weldsuite/forms-engine';
import {
  aiSummaryContentSchema,
  formAiSummarySchema,
  formDetailSchema,
  formFolderSchema,
  formInsightsSchema,
  formIntegrationSchema,
  formInvitationSchema,
  formInvitationStatsSchema,
  formResponseColumnSchema,
  formResponseDetailSchema,
  formResponseSchema,
  formResultsSummarySchema,
  formSubscriptionSchema,
  formSummarySchema,
  formThemeSchema,
  formVersionDetailSchema,
  formVersionSummarySchema,
  formsUsageSchema,
  formsWorkspaceSettingsSchema,
  crmIntegrationConfigSchema,
  deskIntegrationConfigSchema,
  publishResultSchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { createWeldFormsMockApi, type MockReply } from './mock-api';
import { buildFixtures, PREVIEW_FORM_IDS, type WeldFormsFixtures } from './fixtures';

const NOW = new Date('2026-06-15T10:00:00.000Z');
const fresh = () => createWeldFormsMockApi(buildFixtures(NOW), () => NOW);

function call(api: ReturnType<typeof fresh>, method: string, path: string, body?: unknown): MockReply {
  const url = new URL(`https://app.test${path}`);
  return api.handle({ method, pathname: url.pathname, search: url.searchParams, body });
}

function data(reply: MockReply): unknown {
  expect(reply.status).toBeLessThan(300);
  return (reply.body as { data: unknown }).data;
}

function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues.slice(0, 5), null, 2));
  return result.data;
}

const F = '/api/forms/forms';
const FEEDBACK = PREVIEW_FORM_IDS.feedback;

describe('WeldForms preview fixtures', () => {
  const fx: WeldFormsFixtures = buildFixtures(NOW);

  it('builds four forms in two folders, three of them published', () => {
    expect(fx.records.map((r) => r.detail.status)).toEqual(['published', 'published', 'published', 'draft']);
    expect(fx.folders).toHaveLength(2);
    expect(new Set(fx.records.map((r) => r.detail.folderId).filter(Boolean)).size).toBe(2);
  });

  it('keeps every form valid against the contract and the engine', () => {
    for (const { detail, versions } of fx.records) {
      parse(formDetailSchema, detail);
      expect(parseDefinition(detail.definition).ok).toBe(true);
      for (const v of versions) {
        parse(formVersionDetailSchema, v);
        expect(parseDefinition(v.definition).ok).toBe(true);
      }
    }
  });

  it('has about 40 completed feedback responses over the last 14 days', () => {
    const record = fx.records.find((r) => r.detail.id === FEEDBACK)!;
    expect(record.responses).toHaveLength(40);
    const from = Date.parse('2026-06-01T00:00:00Z');
    for (const r of record.responses) {
      expect(r.status).toBe('completed');
      parse(formResponseSchema, r);
      expect(Date.parse(r.submittedAt!)).toBeGreaterThanOrEqual(from);
      expect(Date.parse(r.submittedAt!)).toBeLessThanOrEqual(NOW.getTime());
    }
    const days = new Set(record.responses.map((r) => r.submittedAt!.slice(0, 10)));
    expect(days.size).toBeGreaterThan(6);
  });

  it('stores answers the engine accepts on the path they were given', () => {
    for (const record of fx.records) {
      for (const r of record.responses) {
        const result = evaluateSubmission(record.detail.definition, { answers: r.answers as never });
        expect(result.ok, `${r.id} ${JSON.stringify(result.errors)}`).toBe(true);
        expect(r.score).toBe(Object.keys(r.variables).length > 0 ? result.score : null);
      }
    }
  });

  it('is repeatable for the same anchor', () => {
    expect(buildFixtures(NOW)).toEqual(fx);
  });

  it('validates the workspace pieces', () => {
    for (const f of fx.folders) parse(formFolderSchema, f);
    for (const t of fx.themes) parse(formThemeSchema, t);
    parse(formsWorkspaceSettingsSchema, fx.settings);
    parse(formsUsageSchema, fx.usage);
    for (const record of fx.records) {
      for (const i of record.invitations) parse(formInvitationSchema, i);
      for (const i of record.integrations) {
        parse(formIntegrationSchema, i);
        if (i.kind === 'crm') parse(crmIntegrationConfigSchema, i.config);
        if (i.kind === 'desk') parse(deskIntegrationConfigSchema, i.config);
      }
    }
  });
});

describe('WeldForms preview mock API', () => {
  it('answers the form list and one form in the contract shapes', () => {
    const api = fresh();
    const list = call(api, 'GET', F).body as { data: unknown[]; pagination: { totalCount: number; hasMore: boolean } };
    expect(list.data).toHaveLength(4);
    for (const item of list.data) parse(formSummarySchema, item);
    expect(list.pagination).toMatchObject({ totalCount: 4, hasMore: false });

    const detail = parse(formDetailSchema, data(call(api, 'GET', `${F}/${FEEDBACK}`)));
    expect(detail.title).toBe('Customer feedback (NPS)');
  });

  it('filters the list by folder, status and search', () => {
    const api = fresh();
    const count = (query: string) => (call(api, 'GET', `${F}?${query}`).body as { data: unknown[] }).data.length;
    expect(count('folderId=fld_preview_events')).toBe(2);
    expect(count('folderId=none')).toBe(1);
    expect(count('status=draft')).toBe(1);
    expect(count('q=quiz')).toBe(1);
  });

  it('answers results: columns, responses, summary and insights', () => {
    const api = fresh();
    const columns = data(call(api, 'GET', `${F}/${FEEDBACK}/columns`)) as unknown[];
    for (const c of columns) parse(formResponseColumnSchema, c);
    expect(columns.length).toBeGreaterThan(5);

    const first = call(api, 'GET', `${F}/${FEEDBACK}/responses?limit=25`).body as {
      data: unknown[];
      pagination: { hasMore: boolean; cursor: string | null; totalCount: number };
    };
    expect(first.data).toHaveLength(25);
    expect(first.pagination).toMatchObject({ hasMore: true, totalCount: 40 });
    const second = call(api, 'GET', `${F}/${FEEDBACK}/responses?limit=25&cursor=${first.pagination.cursor}`).body as { data: unknown[] };
    expect(second.data).toHaveLength(15);

    const rid = (first.data[0] as { id: string }).id;
    parse(formResponseDetailSchema, data(call(api, 'GET', `${F}/${FEEDBACK}/responses/${rid}`)));

    const summary = parse(formResultsSummarySchema, data(call(api, 'GET', `${F}/${FEEDBACK}/summary`)));
    expect(summary.totalResponses).toBe(40);
    expect(summary.fields.map((f) => f.kind)).toContain('nps');

    const insights = parse(formInsightsSchema, data(call(api, 'GET', `${F}/${FEEDBACK}/insights`)));
    expect(insights.completions).toBe(40);
    expect(insights.starts).toBeGreaterThan(40);
    expect(insights.byDay.length).toBeGreaterThanOrEqual(14);
    expect(insights.dropOff.length).toBeGreaterThan(0);
  });

  it('scores the quiz and keeps the summary in step with a range', () => {
    const api = fresh();
    const quiz = parse(formResultsSummarySchema, data(call(api, 'GET', `${F}/${PREVIEW_FORM_IDS.quiz}/summary`)));
    expect(quiz.averageScore).not.toBeNull();
    const none = parse(formResultsSummarySchema, data(call(api, 'GET', `${F}/${FEEDBACK}/summary?from=2030-01-01T00:00:00.000Z`)));
    expect(none.totalResponses).toBe(0);
  });

  it('answers versions, access, subscription, invitations and integrations', () => {
    const api = fresh();
    const versions = data(call(api, 'GET', `${F}/${FEEDBACK}/versions`)) as unknown[];
    for (const v of versions) parse(formVersionSummarySchema, v);
    expect(versions).toHaveLength(1);
    expect(data(call(api, 'GET', `${F}/${FEEDBACK}/access`))).toHaveLength(2);
    parse(formSubscriptionSchema, data(call(api, 'GET', `${F}/${FEEDBACK}/subscription`)));

    const event = PREVIEW_FORM_IDS.event;
    const invitations = call(api, 'GET', `${F}/${event}/invitations`).body as { data: unknown[] };
    expect(invitations.data.length).toBeGreaterThan(0);
    for (const i of invitations.data) parse(formInvitationSchema, i);
    parse(formInvitationStatsSchema, data(call(api, 'GET', `${F}/${event}/invitations/stats`)));

    const integrations = data(call(api, 'GET', `${F}/${FEEDBACK}/integrations`)) as unknown[];
    for (const i of integrations) parse(formIntegrationSchema, i);
    expect(integrations).toHaveLength(2);

    const ai = parse(formAiSummarySchema, data(call(api, 'GET', `${F}/${FEEDBACK}/ai/summary`)));
    parse(aiSummaryContentSchema, ai.summary);
  });

  it('answers folders, themes, settings and usage', () => {
    const api = fresh();
    for (const f of data(call(api, 'GET', '/api/forms/folders')) as unknown[]) parse(formFolderSchema, f);
    expect(data(call(api, 'GET', '/api/forms/themes'))).toHaveLength(3);
    parse(formsWorkspaceSettingsSchema, data(call(api, 'GET', '/api/forms/settings')));
    parse(formsUsageSchema, data(call(api, 'GET', '/api/forms/usage')));
    const members = call(api, 'GET', '/api/team-members').body as { data: Array<{ userId: string }> };
    expect(members.data.length).toBeGreaterThan(2);
  });

  it('lets the builder save, detects a stale revision and publishes', () => {
    const api = fresh();
    const draft = parse(formDetailSchema, data(call(api, 'GET', `${F}/${PREVIEW_FORM_IDS.contact}`)));

    const saved = parse(formDetailSchema, data(call(api, 'PATCH', `${F}/${draft.id}`, { revision: draft.revision, title: 'Renamed' })));
    expect(saved.title).toBe('Renamed');
    expect(saved.revision).toBe(draft.revision + 1);

    const stale = call(api, 'PATCH', `${F}/${draft.id}`, { revision: draft.revision, title: 'Again' });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');

    const published = parse(publishResultSchema, data(call(api, 'POST', `${F}/${draft.id}/publish`)));
    expect(published.form.status).toBe('published');
    expect(published.form.publicUrl).toContain('/f/');
    expect(data(call(api, 'GET', `${F}/${draft.id}/versions`))).toHaveLength(1);
  });

  it('creates from a template, duplicates, deletes and moves between folders', () => {
    const api = fresh();
    const created = parse(formDetailSchema, data(call(api, 'POST', F, { title: 'Job intake', templateId: 'job-application' })));
    expect(created.definition.blocks.length).toBeGreaterThan(3);
    expect(call(api, 'POST', F, { title: 'x', templateId: 'nope' }).status).toBe(422);

    parse(formDetailSchema, data(call(api, 'POST', `${F}/${created.id}/duplicate`, {})));
    expect((call(api, 'GET', F).body as { data: unknown[] }).data).toHaveLength(6);

    expect(call(api, 'DELETE', `${F}/${created.id}`).status).toBe(204);
    expect(call(api, 'GET', `${F}/${created.id}`).status).toBe(404);

    const folder = parse(formFolderSchema, data(call(api, 'POST', '/api/forms/folders', { name: 'HR' })));
    expect(folder.formCount).toBe(0);
    expect(call(api, 'DELETE', `/api/forms/folders/${folder.id}`).status).toBe(204);
  });

  it('refuses to publish an empty form and exports CSV', () => {
    const api = fresh();
    const blank = parse(formDetailSchema, data(call(api, 'POST', F, { title: 'Blank' })));
    const refused = call(api, 'POST', `${F}/${blank.id}/publish`);
    expect(refused.status).toBe(422);
    expect((refused.body as { error: { code: string } }).error.code).toBe('NO_QUESTIONS');

    const csv = call(api, 'GET', `${F}/${FEEDBACK}/responses/export?format=csv`);
    expect(csv.contentType).toBe('text/csv');
    expect(csv.text!.split('\n')).toHaveLength(41);
  });

  it('answers 404 for anything it has no fixture for', () => {
    expect(call(fresh(), 'GET', '/api/forms/unknown').status).toBe(404);
  });
});
