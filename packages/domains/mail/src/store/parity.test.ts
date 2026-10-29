/**
 * `store/parity.ts` (task C3, design §2.2/§4): the sample-rate parsing, the
 * pure `compareMailboxStats`/`compareThreadPage` diffing (and the
 * normalisations they apply for the known, intended differences), and the
 * `ParitySampler` that wires them into a background, never-throwing check.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PARITY_SAMPLE_RATE,
  ParitySampler,
  bodiesPresenceEqual,
  compareMailboxStats,
  compareThreadPage,
  parseParitySampleRate,
  shouldSampleParity,
} from './parity';
import type { MailboxRef, MailboxStats, MailboxStore, ThreadListQuery, ThreadPage } from './types';
import type { ThreadListMessage, ThreadSummary } from '../threads';

const REF: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1' };

function fakeMessage(overrides: Record<string, unknown> = {}): ThreadListMessage {
  return {
    id: 'msg_1',
    labels: [],
    isStarred: false,
    isImportant: false,
    isTrash: false,
    isSpam: false,
    isRead: true,
    ...overrides,
  } as unknown as ThreadListMessage;
}

function fakeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: 't1',
    accountId: 'acc_1',
    subject: 'Test',
    participants: [],
    latestMessageId: 'msg_1',
    latestSender: 'A',
    latestSenderEmail: 'a@test.dev',
    latestSenderAvatarUrl: null,
    latestDate: new Date('2026-01-01'),
    preview: '',
    messageCount: 1,
    unreadCount: 0,
    hasAttachments: false,
    isStarred: false,
    labels: [],
    scheduledFor: null,
    sendStatus: null,
    messages: [fakeMessage()],
    ...overrides,
  };
}

function fakeStats(overrides: Partial<MailboxStats> = {}): MailboxStats {
  return {
    total: 0,
    unread: 0,
    inboxUnread: 0,
    starred: 0,
    importantUnread: 0,
    sentUnread: 0,
    archiveUnread: 0,
    trashUnread: 0,
    spam: 0,
    snoozed: 0,
    scheduled: 0,
    drafts: 0,
    labels: {},
    ...overrides,
  };
}

function fakePage(threads: ThreadSummary[], overrides: Partial<ThreadPage> = {}): ThreadPage {
  return { threads, totalCount: threads.length, nextCursor: null, ...overrides };
}

describe('parseParitySampleRate', () => {
  it('defaults to 5% when unset', () => {
    expect(parseParitySampleRate({})).toBe(DEFAULT_PARITY_SAMPLE_RATE);
  });

  it('parses a valid value', () => {
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: '0.5' })).toBe(0.5);
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: '0' })).toBe(0);
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: '1' })).toBe(1);
  });

  it('falls back to the default for non-numeric or out-of-range values', () => {
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: 'not-a-number' })).toBe(DEFAULT_PARITY_SAMPLE_RATE);
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: '-0.1' })).toBe(DEFAULT_PARITY_SAMPLE_RATE);
    expect(parseParitySampleRate({ MAILBOX_PARITY_SAMPLE_RATE: '1.5' })).toBe(DEFAULT_PARITY_SAMPLE_RATE);
  });
});

describe('shouldSampleParity', () => {
  it('samples when the roll is below the rate, not otherwise', () => {
    expect(shouldSampleParity(0.5, () => 0.4)).toBe(true);
    expect(shouldSampleParity(0.5, () => 0.6)).toBe(false);
  });

  it('rate 0 never samples, rate 1 always does', () => {
    expect(shouldSampleParity(0, () => 0)).toBe(false);
    expect(shouldSampleParity(1, () => 0.999)).toBe(true);
  });
});

describe('compareMailboxStats', () => {
  it('reports no diffs for identical stats', () => {
    const stats = fakeStats({ total: 5, unread: 2, labels: { inbox: { messages: 5, unread: 2, threads: 3 } } });
    expect(compareMailboxStats(stats, { ...stats, labels: { ...stats.labels } })).toEqual([]);
  });

  it('reports a top-level field mismatch', () => {
    const pg = fakeStats({ total: 5 });
    const obj = fakeStats({ total: 6 });
    const diffs = compareMailboxStats(pg, obj);
    expect(diffs).toEqual([{ field: 'total', postgres: 5, object: 6 }]);
  });

  it('a custom label present on one side only, both zero, is NOT a diff (design: "empty custom labels have no zero row in object stats()")', () => {
    const pg = fakeStats({ labels: { promo: { messages: 0, unread: 0, threads: 0 } } });
    const obj = fakeStats({ labels: {} });
    expect(compareMailboxStats(pg, obj)).toEqual([]);
  });

  it('a genuine label-count mismatch is still reported', () => {
    const pg = fakeStats({ labels: { promo: { messages: 3, unread: 1, threads: 2 } } });
    const obj = fakeStats({ labels: { promo: { messages: 2, unread: 1, threads: 2 } } });
    const diffs = compareMailboxStats(pg, obj);
    expect(diffs).toEqual([
      { field: 'labels.promo', postgres: { messages: 3, unread: 1, threads: 2 }, object: { messages: 2, unread: 1, threads: 2 } },
    ]);
  });
});

describe('compareThreadPage', () => {
  it('reports no diffs for identical pages', () => {
    const page = fakePage([fakeThread()]);
    expect(compareThreadPage(page, fakePage([fakeThread()]))).toEqual([]);
  });

  it('reports a thread-order diff when the key order differs', () => {
    const pg = fakePage([fakeThread({ threadId: 't1' }), fakeThread({ threadId: 't2' })]);
    const obj = fakePage([fakeThread({ threadId: 't2' }), fakeThread({ threadId: 't1' })]);
    const diffs = compareThreadPage(pg, obj);
    expect(diffs.some((d) => d.field === 'threadOrder')).toBe(true);
  });

  it('reports messageCount/unreadCount/latestMessageId diffs per thread', () => {
    const pg = fakePage([fakeThread({ threadId: 't1', messageCount: 2, unreadCount: 1, latestMessageId: 'msg_a' })]);
    const obj = fakePage([fakeThread({ threadId: 't1', messageCount: 3, unreadCount: 0, latestMessageId: 'msg_b' })]);
    const diffs = compareThreadPage(pg, obj);
    expect(diffs.map((d) => d.field)).toEqual(
      expect.arrayContaining(['thread.t1.messageCount', 'thread.t1.unreadCount', 'thread.t1.latestMessageId']),
    );
  });

  it('folds isImportant/isStarred/isTrash/isSpam into the Postgres label set before comparing (the AI-categories gap)', () => {
    // Postgres: AI classification set isImportant=true on the message row without adding IMPORTANT to labels.
    const pgThread = fakeThread({
      threadId: 't1',
      labels: ['INBOX'],
      messages: [fakeMessage({ labels: ['INBOX'], isImportant: true })],
    });
    // Object: labels_json and the derived `important` flag are always in lockstep.
    const objThread = fakeThread({ threadId: 't1', labels: ['INBOX', 'IMPORTANT'] });
    expect(compareThreadPage(fakePage([pgThread]), fakePage([objThread]))).toEqual([]);
  });

  it('still reports a genuine label-set difference the flag-folding does not explain', () => {
    const pgThread = fakeThread({ threadId: 't1', labels: ['INBOX'], messages: [fakeMessage({ labels: ['INBOX'] })] });
    const objThread = fakeThread({ threadId: 't1', labels: ['INBOX', 'SPAM'] });
    const diffs = compareThreadPage(fakePage([pgThread]), fakePage([objThread]));
    expect(diffs.some((d) => d.field === 'thread.t1.labels')).toBe(true);
  });

  it('skips per-thread comparison for a thread missing on the other side (already reflected in threadOrder)', () => {
    const pg = fakePage([fakeThread({ threadId: 't1' }), fakeThread({ threadId: 't2' })]);
    const obj = fakePage([fakeThread({ threadId: 't1' })]);
    const diffs = compareThreadPage(pg, obj);
    expect(diffs).toEqual([{ field: 'threadOrder', postgres: ['t1', 't2'], object: ['t1'] }]);
  });
});

describe('bodiesPresenceEqual', () => {
  it('is true when both sides have (or both lack) a body, regardless of content', () => {
    expect(bodiesPresenceEqual({ textBody: 'hello' }, { textBody: 'different text' })).toBe(true);
    expect(bodiesPresenceEqual({ textBody: null }, { textBody: null })).toBe(true);
  });

  it('is false when presence differs', () => {
    expect(bodiesPresenceEqual({ textBody: 'hello' }, { textBody: null })).toBe(false);
    expect(bodiesPresenceEqual({ htmlBody: null }, { htmlBody: '<p>hi</p>' })).toBe(false);
  });
});

describe('ParitySampler', () => {
  function fakeObjectMailbox(overrides: Partial<Pick<MailboxStore, 'listThreads' | 'stats'>> = {}) {
    return {
      listThreads: vi.fn(async (): Promise<ThreadPage> => fakePage([fakeThread()])),
      stats: vi.fn(async (): Promise<MailboxStats> => fakeStats()),
      ...overrides,
    } as unknown as Pick<MailboxStore, 'listThreads' | 'stats'>;
  }

  const Q: ThreadListQuery = { labelSlug: 'inbox', pageSize: 20 };

  it('sampleListThreads returns null for a search query (design: "searches skipped") without calling the object', () => {
    const object = fakeObjectMailbox();
    const sampler = new ParitySampler({ rate: 1 });
    const result = sampler.sampleListThreads(REF, { ...Q, search: 'invoice' }, fakePage([]), object);
    expect(result).toBeNull();
    expect(object.listThreads).not.toHaveBeenCalled();
  });

  it('sampleListThreads returns null when the sample roll misses', () => {
    const object = fakeObjectMailbox();
    const sampler = new ParitySampler({ rate: 0, random: () => 0.5 });
    expect(sampler.sampleListThreads(REF, Q, fakePage([]), object)).toBeNull();
    expect(object.listThreads).not.toHaveBeenCalled();
  });

  it('a sampled, matching comparison does not call onMismatch', async () => {
    const page = fakePage([fakeThread()]);
    const object = fakeObjectMailbox({ listThreads: vi.fn(async () => page) });
    const onMismatch = vi.fn();
    const sampler = new ParitySampler({ rate: 1, onMismatch });
    const pending = sampler.sampleListThreads(REF, Q, page, object);
    expect(pending).not.toBeNull();
    await pending;
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('a sampled, mismatching comparison calls onMismatch with ref/kind/diffs and never throws', async () => {
    const pgPage = fakePage([fakeThread({ threadId: 't1', messageCount: 1 })]);
    const objPage = fakePage([fakeThread({ threadId: 't1', messageCount: 2 })]);
    const object = fakeObjectMailbox({ listThreads: vi.fn(async () => objPage) });
    const onMismatch = vi.fn();
    const sampler = new ParitySampler({ rate: 1, onMismatch });
    await sampler.sampleListThreads(REF, Q, pgPage, object);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    const [mismatch] = onMismatch.mock.calls[0]!;
    expect(mismatch.ref).toBe(REF);
    expect(mismatch.kind).toBe('listThreads');
    expect(mismatch.diffs.length).toBeGreaterThan(0);
  });

  it('never throws when the object read itself fails', async () => {
    const object = fakeObjectMailbox({ listThreads: vi.fn(async () => { throw new Error('object down'); }) });
    const sampler = new ParitySampler({ rate: 1 });
    await expect(sampler.sampleListThreads(REF, Q, fakePage([]), object)).resolves.toBeUndefined();
  });

  it('never throws when onMismatch itself throws', async () => {
    const pgPage = fakePage([fakeThread({ threadId: 't1', messageCount: 1 })]);
    const objPage = fakePage([fakeThread({ threadId: 't1', messageCount: 2 })]);
    const object = fakeObjectMailbox({ listThreads: vi.fn(async () => objPage) });
    const sampler = new ParitySampler({
      rate: 1,
      onMismatch: () => {
        throw new Error('handler exploded');
      },
    });
    await expect(sampler.sampleListThreads(REF, Q, pgPage, object)).resolves.toBeUndefined();
  });

  it('sampleStats mirrors the same behaviour for stats', async () => {
    const pg = fakeStats({ total: 1 });
    const obj = fakeStats({ total: 2 });
    const object = fakeObjectMailbox({ stats: vi.fn(async () => obj) });
    const onMismatch = vi.fn();
    const sampler = new ParitySampler({ rate: 1, onMismatch });
    await sampler.sampleStats(REF, pg, object);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch.mock.calls[0]![0].kind).toBe('stats');
  });

  it('sampleStats returns null when the sample roll misses', () => {
    const object = fakeObjectMailbox();
    const sampler = new ParitySampler({ rate: 0 });
    expect(sampler.sampleStats(REF, fakeStats(), object)).toBeNull();
    expect(object.stats).not.toHaveBeenCalled();
  });
});
