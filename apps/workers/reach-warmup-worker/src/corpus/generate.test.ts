import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWeldAI, generateObject, isGatewayConfigured } from '@weldsuite/ai';
import type { Env } from '../env';
import { BUILTIN_CORPUS } from './builtin';
import { CORPUS_LATEST_KEY, CORPUS_META_KEY } from './constants';
import { createFakeR2 } from './fake-r2.test-helper';
import {
  BATCH_COUNT,
  CORPUS_MODEL_ID,
  THREADS_PER_BATCH,
  TOPICS,
  buildBatchPlan,
  refreshCorpus,
  sanitizeGeneratedText,
} from './generate';
import { loadCorpus, resetCorpusCache } from './load';
import { parseCorpusThreads } from './validate';

vi.mock('@weldsuite/ai', () => ({
  createWeldAI: vi.fn(() => ({ model: (id: string) => ({ modelId: id }) })),
  generateObject: vi.fn(),
  isGatewayConfigured: vi.fn(() => true),
  jsonSchema: <T>(schema: T) => schema,
  recommended: { draft: { quality: 'provider/quality-model' } },
}));

const NOW = new Date('2026-10-13T06:00:00.000Z');
const THREADS_PER_CALL = 7;

interface Draft {
  subject: string;
  messages: Array<{ author: string; body: string }>;
}

/** The index-th draft: built-in threads first, then the same ones again under a numbered subject. */
function draftOf(index: number): Draft {
  const thread = BUILTIN_CORPUS[index % BUILTIN_CORPUS.length];
  if (!thread) throw new Error('fixture');
  const round = Math.floor(index / BUILTIN_CORPUS.length);
  return {
    subject: round === 0 ? thread.subject : `${thread.subject} (${round + 1})`,
    messages: thread.messages.map((message) => ({ ...message })),
  };
}

/** Every call returns `THREADS_PER_CALL` fresh drafts (distinct subjects across calls). */
function mockModelReturningValidThreads(): void {
  let call = 0;
  vi.mocked(generateObject).mockImplementation((async () => {
    const start = call * THREADS_PER_CALL;
    call += 1;
    return { object: { threads: Array.from({ length: THREADS_PER_CALL }, (_, i) => draftOf(start + i)) } };
  }) as unknown as typeof generateObject);
}

function envWith(storage?: R2Bucket): Env {
  return { ENVIRONMENT: 'test', DATABASE_URL_MASTER: 'postgres://unused', STORAGE: storage };
}

function metaJson(generatedAt: string): string {
  return JSON.stringify({ generatedAt });
}

describe('refreshCorpus', () => {
  beforeEach(() => {
    resetCorpusCache();
    vi.mocked(generateObject).mockReset();
    vi.mocked(createWeldAI).mockClear();
    vi.mocked(isGatewayConfigured).mockReset();
    vi.mocked(isGatewayConfigured).mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  describe('skips without calling the model', () => {
    it('when there is no bucket', async () => {
      expect(await refreshCorpus(envWith(), NOW)).toEqual({ refreshed: false });
      expect(generateObject).not.toHaveBeenCalled();
    });

    it('when AI is not configured', async () => {
      vi.mocked(isGatewayConfigured).mockReturnValue(false);
      const r2 = createFakeR2();
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(generateObject).not.toHaveBeenCalled();
      expect(r2.puts).toEqual([]);
    });

    it('when the stored set is younger than 30 days', async () => {
      const r2 = createFakeR2({ [CORPUS_META_KEY]: metaJson('2026-09-20T00:00:00.000Z') });
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(generateObject).not.toHaveBeenCalled();
      expect(r2.puts).toEqual([]);
    });

    it('when the stored set is generated in the future (clock skew)', async () => {
      const r2 = createFakeR2({ [CORPUS_META_KEY]: metaJson('2026-11-01T00:00:00.000Z') });
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(generateObject).not.toHaveBeenCalled();
    });
  });

  describe('generates', () => {
    it('writes latest, archive and meta when the stored set is older than 30 days', async () => {
      mockModelReturningValidThreads();
      const r2 = createFakeR2({ [CORPUS_META_KEY]: metaJson('2026-08-01T00:00:00.000Z') });

      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: true });

      expect(generateObject).toHaveBeenCalledTimes(BATCH_COUNT);
      expect(r2.puts).toEqual(['reach-warmup/corpus/2026-10.json', CORPUS_LATEST_KEY, CORPUS_META_KEY]);

      const latest: unknown = JSON.parse(r2.store.get(CORPUS_LATEST_KEY) ?? 'null');
      const threads = parseCorpusThreads(latest);
      expect(threads).toHaveLength(BATCH_COUNT * THREADS_PER_CALL);
      expect(threads[0]?.id).toBe('gen-2026-10-001');
      expect(threads.at(-1)?.id).toBe(`gen-2026-10-${String(threads.length).padStart(3, '0')}`);
      expect(r2.store.get('reach-warmup/corpus/2026-10.json')).toBe(r2.store.get(CORPUS_LATEST_KEY));

      const meta: unknown = JSON.parse(r2.store.get(CORPUS_META_KEY) ?? 'null');
      expect(meta).toMatchObject({ generatedAt: NOW.toISOString(), threads: threads.length });
    });

    it('keeps the replaced set as previous.json', async () => {
      mockModelReturningValidThreads();
      const old = JSON.stringify([{ id: 'gen-2026-08-001' }]);
      const r2 = createFakeR2({ [CORPUS_META_KEY]: metaJson('2026-08-01T00:00:00.000Z'), [CORPUS_LATEST_KEY]: old });

      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: true });
      expect(r2.store.get('reach-warmup/corpus/previous.json')).toBe(old);
      expect(r2.puts.indexOf('reach-warmup/corpus/previous.json')).toBeLessThan(r2.puts.indexOf(CORPUS_LATEST_KEY));
    });

    it('generates when there is no meta yet, and when the meta is unreadable', async () => {
      mockModelReturningValidThreads();
      const fresh = createFakeR2();
      expect(await refreshCorpus(envWith(fresh.bucket), NOW)).toEqual({ refreshed: true });

      vi.mocked(generateObject).mockReset();
      mockModelReturningValidThreads();
      const broken = createFakeR2({ [CORPUS_META_KEY]: '{ nope' });
      expect(await refreshCorpus(envWith(broken.bucket), NOW)).toEqual({ refreshed: true });
    });

    it('asks the configured model for one batch of briefs per call', async () => {
      mockModelReturningValidThreads();
      await refreshCorpus(envWith(createFakeR2().bucket), NOW);

      const calls = vi.mocked(generateObject).mock.calls;
      expect(calls).toHaveLength(BATCH_COUNT);
      const prompts = calls.map(([options]) => String((options as unknown as { prompt: unknown }).prompt));
      expect(new Set(prompts).size).toBe(BATCH_COUNT);
      for (const prompt of prompts) expect(prompt.match(/^Brief \d+:/gm) ?? []).toHaveLength(THREADS_PER_BATCH);
      const first = calls[0]?.[0] as unknown as { system?: string; model?: unknown } | undefined;
      expect(first?.model).toEqual({ modelId: CORPUS_MODEL_ID });
      expect(first?.system).toMatch(/Plain text only/);
      expect(first?.system).toMatch(/\{\{recipientFirstName\}\}/);
    });

    it('serves the new set to loadCorpus right after (cache reset)', async () => {
      mockModelReturningValidThreads();
      const r2 = createFakeR2();
      const env = envWith(r2.bucket);
      const before = await loadCorpus(env);
      expect(before[0]?.id).toBe('builtin-001');

      await refreshCorpus(env, NOW);
      const after = await loadCorpus(env);
      expect(after[0]?.id).toBe('gen-2026-10-001');
    });

    it('drops threads with links, spam words or repeated subjects, and keeps the rest', async () => {
      let call = 0;
      vi.mocked(generateObject).mockImplementation((async () => {
        const start = call * 9;
        call += 1;
        const good = Array.from({ length: 6 }, (_, i) => draftOf(start + i));
        const withLink = { ...draftOf(start + 6), subject: 'A subject with a link' };
        withLink.messages[0] = { author: 'starter', body: 'Hi {{recipientFirstName}}, read http://example.invalid before we meet.' };
        const spammy = { ...draftOf(start + 7), subject: 'Free tickets this week' };
        const repeated = draftOf(start); // same subject as the first good one
        return { object: { threads: [...good, withLink, spammy, repeated] } };
      }) as unknown as typeof generateObject);

      const r2 = createFakeR2();
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: true });

      const threads = parseCorpusThreads(JSON.parse(r2.store.get(CORPUS_LATEST_KEY) ?? 'null'));
      expect(threads).toHaveLength(BATCH_COUNT * 6);
      expect(threads.some((thread) => thread.subject === 'A subject with a link')).toBe(false);
      expect(threads.some((thread) => /free/i.test(thread.subject))).toBe(false);
      expect(new Set(threads.map((thread) => thread.subject.toLowerCase())).size).toBe(threads.length);
    });

    it('cleans typographic characters and a "Re:" prefix before validating', async () => {
      let call = 0;
      vi.mocked(generateObject).mockImplementation((async () => {
        const start = call * THREADS_PER_CALL;
        call += 1;
        const threads = Array.from({ length: THREADS_PER_CALL }, (_, i) => {
          const draft = draftOf(start + i);
          return {
            subject: `Re: ${draft.subject}.`,
            messages: draft.messages.map((message) => ({
              ...message,
              body: `${message.body}\n\nI’ll check — and let you know…`,
            })),
          };
        });
        return { object: { threads } };
      }) as unknown as typeof generateObject);

      const r2 = createFakeR2();
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: true });
      const threads = parseCorpusThreads(JSON.parse(r2.store.get(CORPUS_LATEST_KEY) ?? 'null'));
      expect(threads).toHaveLength(BATCH_COUNT * THREADS_PER_CALL);
      expect(threads[0]?.subject).toBe(BUILTIN_CORPUS[0]?.subject);
      expect(threads[0]?.messages[0]?.body).toContain("I'll check - and let you know...");
    });

    it('survives batches that fail, as long as enough threads come through', async () => {
      let call = 0;
      vi.mocked(generateObject).mockImplementation((async () => {
        call += 1;
        if (call % 4 === 0) throw new Error('gateway timeout');
        const start = call * THREADS_PER_CALL;
        return { object: { threads: Array.from({ length: THREADS_PER_CALL }, (_, i) => draftOf(start + i)) } };
      }) as unknown as typeof generateObject);

      const r2 = createFakeR2();
      // 9 of 12 batches succeed: 63 threads, over the minimum of 60.
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: true });
      expect(parseCorpusThreads(JSON.parse(r2.store.get(CORPUS_LATEST_KEY) ?? 'null'))).toHaveLength(9 * THREADS_PER_CALL);
    });
  });

  describe('keeps the current set', () => {
    it('when too few valid threads come back', async () => {
      vi.mocked(generateObject).mockImplementation((async () => ({
        object: { threads: [draftOf(0), { subject: 'Free money', messages: [] }, 'nonsense'] },
      })) as unknown as typeof generateObject);
      const r2 = createFakeR2({ [CORPUS_META_KEY]: metaJson('2026-08-01T00:00:00.000Z') });

      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(r2.puts).toEqual([]);
      expect(console.warn).toHaveBeenCalled();
    });

    it('when every model call fails', async () => {
      vi.mocked(generateObject).mockRejectedValue(new Error('no credit left'));
      const r2 = createFakeR2();
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(r2.puts).toEqual([]);
    });

    it('when writing to R2 fails', async () => {
      mockModelReturningValidThreads();
      const r2 = createFakeR2({}, { failPut: true });
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(console.warn).toHaveBeenCalled();
    });

    it('when reading the meta fails', async () => {
      const r2 = createFakeR2({}, { failGet: true });
      expect(await refreshCorpus(envWith(r2.bucket), NOW)).toEqual({ refreshed: false });
      expect(generateObject).not.toHaveBeenCalled();
    });
  });
});

describe('buildBatchPlan', () => {
  it('gives every batch ten briefs on ten different topics', () => {
    for (let batch = 0; batch < BATCH_COUNT; batch += 1) {
      const plan = buildBatchPlan(batch);
      expect(plan).toHaveLength(THREADS_PER_BATCH);
      expect(new Set(plan.map((brief) => brief.topic)).size).toBe(THREADS_PER_BATCH);
      for (const brief of plan) {
        expect(brief.messageCount).toBeGreaterThanOrEqual(2);
        expect(brief.messageCount).toBeLessThanOrEqual(4);
      }
    }
  });

  it('covers the topic list across a run and mixes thread lengths and tones', () => {
    const plans = Array.from({ length: BATCH_COUNT }, (_, batch) => buildBatchPlan(batch)).flat();
    expect(new Set(plans.map((brief) => brief.topic)).size).toBeGreaterThanOrEqual(Math.min(TOPICS.length, 60));
    expect(new Set(plans.map((brief) => brief.messageCount))).toEqual(new Set([2, 3, 4]));
    expect(new Set(plans.map((brief) => brief.tone)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(plans.map((brief) => brief.format)).size).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic and differs between batches', () => {
    expect(buildBatchPlan(3)).toEqual(buildBatchPlan(3));
    expect(buildBatchPlan(3)).not.toEqual(buildBatchPlan(4));
  });
});

describe('sanitizeGeneratedText', () => {
  it('folds typographic characters and tidies whitespace', () => {
    expect(sanitizeGeneratedText('“Hi” there – it’s fine…  \r\n\r\n\r\n\r\nBye  ')).toBe('"Hi" there - it\'s fine...\n\nBye');
  });
});
