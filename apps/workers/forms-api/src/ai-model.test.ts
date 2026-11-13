/**
 * WeldForms' AI routes against pglite (tenant + master) with the model stubbed
 * at the HTTP level (`@weldsuite/ai/testing`), so both backends run them:
 * Global on `@weldsuite/ai`, the Kubernetes editions on `weldsuite-ai`
 * (feature `forms`). Conformance-ready; the mock answers by the request's
 * content, never by call order. The wallet holds credits, so the calls are
 * metered as in production.
 *
 * Prompts and charges are asserted on TypeScript in ai.test.ts, with the AI
 * layer mocked in-process.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockModel, type MockChatReply, type MockChatRequest } from '@weldsuite/ai/testing';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import { fieldsOf, parseDefinition } from '@weldsuite/forms-engine';
import type { FormAiSummary, GenerateFormResult, SuggestBlocksResult } from '@weldsuite/app-api-client/schemas/weldforms';
import aiRoutes from './routes/ai';
import { ORG, WS, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, type World } from './test/support';

const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(dbs.tenant),
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
  };
});

// Conformance mode runs every write on both backends.
vi.setConfig({ testTimeout: 120_000 });

/** The model: a draft, more questions, or a summary, by what it is asked. */
function answer(request: MockChatRequest): MockChatReply {
  const user = request.messages.at(-1)?.text ?? '';
  if (request.system.startsWith('You design forms')) {
    if (user.includes('holograms')) return { json: { questions: [{ type: 'hologram', title: 'Nope' }] } };
    return {
      json: {
        title: 'Event signup',
        questions: [
          { type: 'short_text', title: 'Your name', required: true },
          { type: 'email', title: 'Email address', required: true, description: 'We send the ticket here' },
          { type: 'multiple_choice', title: 'Which sessions?', choices: ['Keynote', 'Workshop', 'Dinner'], multiple: true },
          { type: 'file_upload', title: 'Not allowed' },
          { type: 'short_text', title: 'Your name' },
        ],
        ending: { title: 'See you there!', description: 'Check your inbox.' },
      },
    };
  }
  if (request.system.startsWith('You add questions')) {
    return { json: { questions: [{ type: 'short_text', title: 'Your name' }, { type: 'rating', title: 'How was it?' }] } };
  }
  // A summary: of one question, or of the whole form.
  if (user.includes('What do you love?')) {
    return { json: { overview: 'Mostly positive.', themes: [{ label: 'Support', count: 1, quotes: ['Fast support'] }], sentiment: null } };
  }
  return {
    json: {
      overview: 'Respondents find the site slow.',
      themes: [
        { label: 'Speed', count: 99, quotes: ['The checkout is slow and confusing', 'invented by the model', 'slow loading pages'] },
        { label: 'Pricing', count: 1, quotes: ['Pricing page is unclear'] },
      ],
      sentiment: { positive: 0, neutral: 1, negative: 2 },
    },
  };
}

const mock = createMockModel({ chat: answer });

let db: Database;
let master: MasterDatabase;
let world: World;

const FORM = 'frm_ai_model';
const definition = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', properties: {} },
    { id: 'b_feedback', ref: 'feedback', type: 'long_text', title: 'What could be better?', properties: {} },
    { id: 'b_love', ref: 'love', type: 'short_text', title: 'What do you love?', properties: {} },
    { id: 'b_secret', ref: 'secret', type: 'long_text', title: 'Anything private?', sensitive: true, properties: {} },
    { id: 'b_plan', ref: 'plan', type: 'multiple_choice', title: 'Plan', properties: { choices: [{ id: 'c_a', label: 'Free' }, { id: 'c_b', label: 'Pro' }] } },
  ],
  endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
});

beforeAll(async () => {
  vi.stubGlobal('fetch', mock.fetch);
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  shareMasterDb(master);
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  world = newWorld(mock.env as never);
  await resetForms(db, master);
  await seedWorkspace(master);
  const now = new Date();
  await master.insert(masterSchema.workspaceCredits).values({
    id: 'wcr_forms_ai',
    workspaceId: WS,
    currentBalance: 100_000,
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  });
  await db.insert(schema.forms).values({ id: FORM, title: 'Feedback', definition, settings: {}, ownerUserId: 'user_owner', publicId: 'pubaimodel', status: 'published' });
  await db.insert(schema.formVersions).values({ id: 'fve_ai_model', formId: FORM, number: 1, definition, publishedByUserId: 'user_owner' });
});

const MOUNT = '/api/forms';
const api = (who?: Parameters<typeof memberApp>[4]) => memberApp(MOUNT, aiRoutes, world, db, who);
const withoutAi = () => memberApp(MOUNT, aiRoutes, newWorld(), db);
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

describe('POST /ai/generate', () => {
  it('makes a valid draft from the description, built by the engine', async () => {
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form for our conference', layout: 'classic', language: 'nl' }));
    expect(res.status).toBe(200);
    const result = await data<GenerateFormResult>(res);
    expect(result.title).toBe('Event signup');
    expect(parseDefinition(result.definition).ok).toBe(true);
    expect(result.definition.presentation).toMatchObject({ layout: 'classic', language: 'nl' });
    const fields = fieldsOf(result.definition);
    expect(fields.map((f) => f.ref)).toEqual(['your_name', 'email_address', 'which_sessions', 'your_name_2']);
    expect(fields.every((f) => /^b_[A-Za-z0-9]{8}$/.test(f.id))).toBe(true);
    const sessions = fields[2] as unknown as { properties: { choices: Array<{ label: string }>; multiple: boolean } };
    expect(sessions.properties.choices.map((c) => c.label)).toEqual(['Keynote', 'Workshop', 'Dinner']);
    expect(sessions.properties.multiple).toBe(true);
    expect(result.definition.endings[0]).toMatchObject({ title: 'See you there!', description: 'Check your inbox.' });
  });

  it('answers 502 when the model comes up with nothing usable', async () => {
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'Something about holograms' }));
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe('AI_REQUEST_FAILED');
  });

  it('needs forms:create, a prompt of some length, and AI to be set up', async () => {
    expect((await api({ permissions: ['forms:read'] }).request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form' }))).status).toBe(403);
    expect((await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'short' }))).status).toBe(400);
    const res = await withoutAi().request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form for our conference' }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: 'ai_unavailable' });
  });
});

describe('POST /ai/suggest-blocks', () => {
  it('suggests new blocks whose refs no block of the draft uses', async () => {
    const res = await api().request(`${MOUNT}/ai/suggest-blocks`, json({ prompt: 'Add some questions about the venue', definition }));
    expect(res.status).toBe(200);
    const { blocks } = await data<SuggestBlocksResult>(res);
    expect(blocks.map((b) => b.ref)).toEqual(['your_name', 'how_was_it']);
  });

  it('needs AI', async () => {
    expect((await withoutAi().request(`${MOUNT}/ai/suggest-blocks`, json({ prompt: 'more', definition }))).status).toBe(503);
  });
});

describe('form summaries', () => {
  const SUMMARY = `${MOUNT}/forms/${FORM}/ai/summary`;

  async function respond(n: number, answers: Record<string, unknown>): Promise<void> {
    await db.insert(schema.formResponses).values({ id: `frs_aim${n}`, formId: FORM, versionId: 'fve_ai_model', number: n, status: 'completed', answers, submittedAt: new Date(Date.UTC(2026, 10, n)) });
  }

  beforeEach(async () => {
    await respond(1, { b_name: 'Ada', b_feedback: 'The checkout is slow and confusing', b_love: 'Fast support', b_secret: 'my password is hunter2' });
    await respond(2, { b_name: 'Bob', b_feedback: 'Slow loading pages', b_love: 'Clean design' });
    await respond(3, { b_name: 'Cy', b_feedback: 'Pricing page is unclear' });
  });

  it('has no summary until one is made, then caches it and marks it stale', async () => {
    const empty = await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`));
    expect(empty).toEqual({ blockId: 'b_feedback', summary: null, stale: false, responseCount: 0, createdAt: null });

    const res = await api().request(SUMMARY, json({ blockId: 'b_feedback' }));
    expect(res.status).toBe(200);
    const made = await data<FormAiSummary>(res);
    expect(made).toMatchObject({ blockId: 'b_feedback', stale: false, responseCount: 3 });
    expect(made.summary!.themes[0]).toEqual({ label: 'Speed', count: 3, quotes: ['The checkout is slow and confusing', 'slow loading pages'] });
    expect(made.summary!.sentiment).toEqual({ positive: 0, neutral: 1, negative: 2 });

    const cached = await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`));
    expect(cached).toMatchObject({ stale: false, responseCount: 3, summary: made.summary });

    await respond(4, { b_feedback: 'More of the same' });
    expect(await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`))).toMatchObject({ stale: true, responseCount: 3 });
    // A new one replaces the old.
    await api().request(SUMMARY, json({ blockId: 'b_feedback' }));
    const rows = await db.select().from(schema.formAiSummaries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responseCount).toBe(4);
  });

  it('summarises the whole form from every open-text question', async () => {
    const res = await api().request(SUMMARY, json({ blockId: null }));
    expect(res.status).toBe(200);
    expect(await data<FormAiSummary>(res)).toMatchObject({ blockId: null, responseCount: 3, summary: { sentiment: null } });
    expect(await data<FormAiSummary>(await api().request(SUMMARY))).toMatchObject({ blockId: null, responseCount: 3 });
  });

  it('refuses a question that is not open text or is sensitive, and a form with nothing to read', async () => {
    for (const blockId of ['b_secret', 'b_plan']) {
      const res = await api().request(SUMMARY, json({ blockId }));
      expect(res.status, blockId).toBe(422);
      expect((await errorOf(res)).code).toBe('NOT_SUMMARISABLE');
    }
    expect((await api().request(SUMMARY, json({ blockId: 'b_missing' }))).status).toBe(404);
    await db.delete(schema.formResponses);
    const none = await api().request(SUMMARY, json({ blockId: null }));
    expect(none.status).toBe(422);
    expect((await errorOf(none)).code).toBe('NOTHING_TO_SUMMARISE');
  });

  it('needs a form the member may see, and AI', async () => {
    expect((await api().request(`${MOUNT}/forms/frm_missing/ai/summary`, json({ blockId: null }))).status).toBe(404);
    const res = await withoutAi().request(SUMMARY, json({ blockId: null }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: 'ai_unavailable' });
    expect((await withoutAi().request(SUMMARY)).status).toBe(503);
  });
});
