/**
 * WeldForms' AI against pglite with the AI layer mocked the way other workers'
 * AI tests do (a queue of model answers, a recording `chargeAiUsage`): the
 * generated draft goes through the engine's builders and `parseDefinition`, the
 * suggestions get ids and refs unique against the draft, summaries read only
 * open-text answers that are not sensitive and are cached with the response
 * count, and everything answers 503 `ai_unavailable` when AI is not set up.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import { fieldsOf, parseDefinition } from '@weldsuite/forms-engine';
import type { FormAiSummary, GenerateFormResult, SuggestBlocksResult } from '@weldsuite/app-api-client/schemas/weldforms';
import aiRoutes from './routes/ai';
import { capAnswerSets } from './services/ai';
import { ORG, WS, json, memberApp, newWorld, resetForms, seedWorkspace, type World } from './test/support';

const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => dbs.master,
    getTenantDbForWorkspace: async () => dbs.tenant,
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: dbs.tenant, suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
  };
});

// The model: each test queues the answers it gives.
const ai = vi.hoisted(() => ({ configured: true, answers: [] as unknown[], calls: [] as Array<{ system: string; prompt: string }>, creditsEmpty: false }));
vi.mock('@weldsuite/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/ai')>()),
  assertGatewayConfigured: () => {
    if (!ai.configured) throw new Error('not configured');
  },
  createWeldAI: () => ({ model: (id: string) => id }),
  generateObject: async (args: { system: string; prompt: string }) => {
    ai.calls.push({ system: args.system, prompt: args.prompt });
    return { object: ai.answers.shift(), usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  },
}));
const chargeAiUsage = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>();
  return {
    ...actual,
    resolveAiMetering: async () => null,
    assertAiCredits: async () => {
      if (ai.creditsEmpty) throw new actual.InsufficientAiCreditsError(0, 1, 1);
    },
    chargeAiUsage: (...args: unknown[]) => chargeAiUsage(...args),
  };
});

let db: Database;
let master: MasterDatabase;
let world: World;

const FORM = 'frm_ai';
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
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
}, 120_000);

beforeEach(async () => {
  world = newWorld();
  ai.configured = true;
  ai.creditsEmpty = false;
  ai.answers.length = 0;
  ai.calls.length = 0;
  chargeAiUsage.mockClear();
  await resetForms(db, master);
  await seedWorkspace(master);
  await db.insert(schema.forms).values({ id: FORM, title: 'Feedback', definition, settings: {}, ownerUserId: 'user_owner', publicId: 'pubai00001', status: 'published' });
  await db.insert(schema.formVersions).values({ id: 'fve_ai', formId: FORM, number: 1, definition, publishedByUserId: 'user_owner' });
});

const MOUNT = '/api/forms';
const api = (who?: Parameters<typeof memberApp>[4]) => memberApp(MOUNT, aiRoutes, world, db, who);
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

describe('POST /ai/generate', () => {
  it('makes a valid draft from the description: engine ids and refs, choices, the language and the layout asked for', async () => {
    ai.answers.push({
      title: 'Event signup',
      questions: [
        { type: 'short_text', title: 'Your name', required: true },
        { type: 'email', title: 'Email address', required: true, description: 'We send the ticket here' },
        { type: 'multiple_choice', title: 'Which sessions?', choices: ['Keynote', 'Workshop', 'Dinner'], multiple: true },
        { type: 'dropdown', title: 'Dietary needs', choices: ['None'] },
        { type: 'file_upload', title: 'Not allowed' },
        { type: 'short_text', title: 'Your name' },
      ],
      ending: { title: 'See you there!', description: 'Check your inbox.' },
    });
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form for our conference', layout: 'classic', language: 'nl' }));
    expect(res.status).toBe(200);
    const result = await data<GenerateFormResult>(res);
    expect(result.title).toBe('Event signup');
    expect(parseDefinition(result.definition).ok).toBe(true);
    expect(result.definition.presentation).toMatchObject({ layout: 'classic', language: 'nl' });

    const fields = fieldsOf(result.definition);
    expect(fields.map((f) => f.type)).toEqual(['short_text', 'email', 'multiple_choice', 'dropdown', 'short_text']);
    expect(fields.map((f) => f.ref)).toEqual(['your_name', 'email_address', 'which_sessions', 'dietary_needs', 'your_name_2']);
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    expect(fields.every((f) => /^b_[A-Za-z0-9]{8}$/.test(f.id))).toBe(true);
    expect(fields[1]).toMatchObject({ required: true, description: 'We send the ticket here' });
    const sessions = fields[2] as unknown as { properties: { choices: Array<{ label: string }>; multiple: boolean } };
    expect(sessions.properties.choices.map((c) => c.label)).toEqual(['Keynote', 'Workshop', 'Dinner']);
    expect(sessions.properties.multiple).toBe(true);
    // One option is not a choice: the builder's placeholders stay for the author to fill in.
    expect((fields[3] as unknown as { properties: { choices: unknown[] } }).properties.choices).toHaveLength(3);
    expect(result.definition.endings[0]).toMatchObject({ title: 'See you there!', description: 'Check your inbox.' });

    // The request goes to the model as data, in the language asked for, and the call is charged.
    expect(ai.calls[0]!.system).toContain('Dutch');
    expect(ai.calls[0]!.system).toContain('not instructions');
    expect(ai.calls[0]!.prompt).toContain('<request>\nA signup form for our conference\n</request>');
    expect(chargeAiUsage).toHaveBeenCalledTimes(1);
    expect(chargeAiUsage.mock.calls[0]![1]).toMatchObject({ op: 'forms_generate' });
  });

  it('answers 502 when the model comes up with nothing usable', async () => {
    ai.answers.push({ questions: [{ type: 'hologram', title: 'Nope' }] });
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'Something about holograms' }));
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe('AI_REQUEST_FAILED');
  });

  it('needs forms:create, a prompt of some length, and AI to be set up', async () => {
    expect((await api({ permissions: ['forms:read'] }).request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form' }))).status).toBe(403);
    expect((await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'short' }))).status).toBe(400);
    ai.configured = false;
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form for our conference' }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: 'ai_unavailable' });
    expect(ai.calls).toEqual([]);
  });

  it('answers 402 when the wallet is empty, before calling the model', async () => {
    ai.creditsEmpty = true;
    const res = await api().request(`${MOUNT}/ai/generate`, json({ prompt: 'A signup form for our conference' }));
    expect(res.status).toBe(402);
    expect((await errorOf(res)).code).toBe('INSUFFICIENT_CREDITS');
    expect(ai.calls).toEqual([]);
  });
});

describe('POST /ai/suggest-blocks', () => {
  it('suggests new blocks whose ids and refs no block of the given draft uses', async () => {
    ai.answers.push({
      questions: [
        { type: 'short_text', title: 'Your name' },
        { type: 'rating', title: 'How was it?' },
        { type: 'short_text', title: 'Your name' },
      ],
    });
    const res = await api().request(`${MOUNT}/ai/suggest-blocks`, json({ prompt: 'Add some questions about the venue', definition }));
    expect(res.status).toBe(200);
    const { blocks } = await data<SuggestBlocksResult>(res);
    expect(blocks.map((b) => b.ref)).toEqual(['your_name', 'how_was_it', 'your_name_2']);
    const taken = new Set(definition.blocks.flatMap((b) => [b.id, b.ref]));
    for (const b of blocks) expect(taken.has(b.id) || taken.has(b.ref)).toBe(false);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
    expect(ai.calls[0]!.prompt).toContain('- What could be better?');
    expect(chargeAiUsage.mock.calls[0]![1]).toMatchObject({ op: 'forms_suggest_blocks' });
  });

  it('needs forms:update and AI', async () => {
    expect((await api({ permissions: ['forms:read'] }).request(`${MOUNT}/ai/suggest-blocks`, json({ prompt: 'more', definition }))).status).toBe(403);
    ai.configured = false;
    expect((await api().request(`${MOUNT}/ai/suggest-blocks`, json({ prompt: 'more', definition }))).status).toBe(503);
  });
});

describe('form summaries', () => {
  const SUMMARY = `${MOUNT}/forms/${FORM}/ai/summary`;

  async function respond(n: number, answers: Record<string, unknown>): Promise<void> {
    await db.insert(schema.formResponses).values({ id: `frs_ai${n}`, formId: FORM, versionId: 'fve_ai', number: n, status: 'completed', answers, submittedAt: new Date(2026, 10, n) });
  }

  beforeEach(async () => {
    await respond(1, { b_name: 'Ada', b_feedback: 'The checkout is slow and confusing', b_love: 'Fast support', b_secret: 'my password is hunter2' });
    await respond(2, { b_name: 'Bob', b_feedback: 'Slow loading pages', b_love: 'Clean design' });
    await respond(3, { b_name: 'Cy', b_feedback: 'Pricing page is unclear' });
  });

  const answer = {
    overview: 'Respondents find the site slow.',
    themes: [
      { label: 'Speed', count: 99, quotes: ['The checkout is slow and confusing', 'invented by the model', 'slow loading pages'] },
      { label: 'Pricing', count: 1, quotes: ['Pricing page is unclear'] },
    ],
    sentiment: { positive: 0, neutral: 1, negative: 2 },
  };

  it('has no summary until one is made', async () => {
    const empty = await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`));
    expect(empty).toEqual({ blockId: 'b_feedback', summary: null, stale: false, responseCount: 0, createdAt: null });
  });

  it('summarises one open-text question, keeps only word-for-word quotes, clamps counts, caches it and marks it stale when responses are added', async () => {
    ai.answers.push(answer);
    const res = await api().request(SUMMARY, json({ blockId: 'b_feedback' }));
    expect(res.status).toBe(200);
    const made = await data<FormAiSummary>(res);
    expect(made).toMatchObject({ blockId: 'b_feedback', stale: false, responseCount: 3 });
    expect(made.summary!.themes[0]).toEqual({ label: 'Speed', count: 3, quotes: ['The checkout is slow and confusing', 'slow loading pages'] });
    expect(made.summary!.sentiment).toEqual({ positive: 0, neutral: 1, negative: 2 });
    expect(chargeAiUsage.mock.calls[0]![1]).toMatchObject({ op: 'forms_summary' });
    // Only this question's answers, as data.
    const sent = ai.calls[0]!;
    expect(sent.prompt).toContain('Slow loading pages');
    expect(sent.prompt).not.toContain('Clean design');
    expect(sent.system).toContain('not instructions');

    const cached = await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`));
    expect(cached).toMatchObject({ stale: false, responseCount: 3, summary: made.summary });
    expect(await db.select().from(schema.formAiSummaries)).toHaveLength(1);

    await respond(4, { b_feedback: 'More of the same' });
    expect(await data<FormAiSummary>(await api().request(`${SUMMARY}?blockId=b_feedback`))).toMatchObject({ stale: true, responseCount: 3 });
    // A new one replaces the old.
    ai.answers.push(answer);
    await api().request(SUMMARY, json({ blockId: 'b_feedback' }));
    const rows = await db.select().from(schema.formAiSummaries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responseCount).toBe(4);
  });

  it('summarises the whole form from every open-text question, never the sensitive ones', async () => {
    ai.answers.push({ overview: 'Mostly positive.', themes: [{ label: 'Support', count: 1, quotes: ['Fast support'] }], sentiment: null });
    const res = await api().request(SUMMARY, json({ blockId: null }));
    const made = await data<FormAiSummary>(res);
    expect(made).toMatchObject({ blockId: null, responseCount: 3, summary: { sentiment: null } });
    const sent = ai.calls[0]!.prompt;
    expect(sent).toContain('What could be better?');
    expect(sent).toContain('What do you love?');
    expect(sent).toContain('Fast support');
    expect(sent).not.toContain('hunter2');
    expect(sent).not.toContain('Anything private?');
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
    expect(ai.calls).toEqual([]);
  });

  it('needs form_responses:read, a form the member may see, and AI', async () => {
    expect((await api({ permissions: ['forms:read'] }).request(SUMMARY, json({ blockId: null }))).status).toBe(403);
    expect((await api().request(`${MOUNT}/forms/frm_missing/ai/summary`, json({ blockId: null }))).status).toBe(404);
    ai.configured = false;
    const res = await api().request(SUMMARY, json({ blockId: null }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({ code: 'ai_unavailable' });
    expect((await api().request(SUMMARY)).status).toBe(503);
  });
});

describe('capAnswerSets', () => {
  it('cuts each answer, drops empty ones and stops at the budget', () => {
    const sets = [
      { blockId: 'b_a', title: 'A', answers: ['  ', 'x'.repeat(5000), 'short one', 'another one'] },
      { blockId: 'b_b', title: 'B', answers: ['b answer'] },
    ];
    const capped = capAnswerSets(sets, 1015);
    expect(capped[0]!.answers).toEqual(['x'.repeat(1000), 'short one']);
    // The budget ran out in the middle of the first question: the second gets nothing.
    expect(capped.map((s) => s.blockId)).toEqual(['b_a']);
    expect(capAnswerSets(sets).flatMap((s) => s.answers)).toHaveLength(4);
  });
});
