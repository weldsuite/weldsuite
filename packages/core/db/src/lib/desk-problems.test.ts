/**
 * The pure parts of problem management: which timestamps a status move
 * writes, the summary an incident's panel shows, and the article draft. The
 * database behaviour (linking, listing, sharing) is covered on pglite by the
 * desk-api route tests.
 */

import { describe, expect, it } from 'vitest';
import { deskArticleDraftFromProblem, deskProblemStatusPatch, deskProblemSummaryOf } from './desk-problems';
import type { DeskProblem } from '../schema/desk-problems';

const t1 = new Date('2026-01-01T10:00:00Z');
const t2 = new Date('2026-01-02T10:00:00Z');
const now = new Date('2026-01-03T10:00:00Z');

const none = { knownErrorAt: null, resolvedAt: null, closedAt: null };

describe('deskProblemStatusPatch', () => {
  it('writes nothing when the status does not change', () => {
    expect(deskProblemStatusPatch({ status: 'open', ...none }, 'open', now)).toEqual({});
  });

  it('sets knownErrorAt on entering known_error, keeping an earlier one', () => {
    expect(deskProblemStatusPatch({ status: 'investigating', ...none }, 'known_error', now)).toEqual({
      knownErrorAt: now,
      resolvedAt: null,
      closedAt: null,
    });
    expect(
      deskProblemStatusPatch({ status: 'resolved', knownErrorAt: t1, resolvedAt: t2, closedAt: null }, 'known_error', now),
    ).toEqual({ knownErrorAt: t1, resolvedAt: null, closedAt: null });
  });

  it('sets resolvedAt on resolving and clears closedAt when reopened from closed', () => {
    expect(deskProblemStatusPatch({ status: 'known_error', ...none, knownErrorAt: t1 }, 'resolved', now)).toEqual({
      resolvedAt: now,
      closedAt: null,
    });
    expect(
      deskProblemStatusPatch({ status: 'closed', knownErrorAt: null, resolvedAt: t1, closedAt: t2 }, 'resolved', now),
    ).toEqual({ resolvedAt: now, closedAt: null });
  });

  it('sets closedAt on closing, and resolvedAt only when it was never resolved', () => {
    expect(deskProblemStatusPatch({ status: 'open', ...none }, 'closed', now)).toEqual({ closedAt: now, resolvedAt: now });
    expect(
      deskProblemStatusPatch({ status: 'resolved', knownErrorAt: null, resolvedAt: t1, closedAt: null }, 'closed', now),
    ).toEqual({ closedAt: now, resolvedAt: t1 });
  });

  it('clears every timestamp when going back to open or investigating', () => {
    const closed = { status: 'closed' as const, knownErrorAt: t1, resolvedAt: t1, closedAt: t2 };
    expect(deskProblemStatusPatch(closed, 'open', now)).toEqual(none);
    expect(deskProblemStatusPatch(closed, 'investigating', now)).toEqual(none);
  });
});

describe('deskProblemSummaryOf', () => {
  it('keeps only what the details panel needs', () => {
    const row = {
      id: 'dprob_1',
      problemNumber: 4,
      title: 'Checkout fails',
      status: 'known_error',
      workaround: 'Use PayPal',
      rootCause: null,
      description: 'long',
      assigneeId: 'u',
    } as DeskProblem;
    expect(deskProblemSummaryOf(row)).toEqual({
      id: 'dprob_1',
      problemNumber: 4,
      title: 'Checkout fails',
      status: 'known_error',
      workaround: 'Use PayPal',
      rootCause: null,
    });
  });
});

describe('deskArticleDraftFromProblem', () => {
  it('writes symptoms, cause and workaround as escaped sections and skips empty ones', () => {
    const draft = deskArticleDraftFromProblem({
      title: 'Checkout <fails>',
      description: 'Pay button\ndoes nothing',
      rootCause: null,
      workaround: 'Use "PayPal"',
    });
    expect(draft.title).toBe('Checkout <fails>');
    expect(draft.content).toBe(
      '<h2>Symptoms</h2><p>Pay button<br>does nothing</p><h2>Workaround</h2><p>Use &quot;PayPal&quot;</p>',
    );
    expect(draft.excerpt).toBe('Use "PayPal"');
  });

  it('has an empty paragraph when the problem has no text yet', () => {
    expect(deskArticleDraftFromProblem({ title: 'x', description: null, rootCause: null, workaround: null })).toEqual({
      title: 'x',
      content: '<p></p>',
      excerpt: null,
    });
  });
});
