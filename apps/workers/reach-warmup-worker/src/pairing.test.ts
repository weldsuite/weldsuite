import { describe, expect, it } from 'vitest';
import {
  RECEIVE_HEADROOM,
  createPairingState,
  pairKey,
  pickRecipient,
  pickThreadId,
  type PairingMailbox,
  type PairingState,
} from './pairing';
import { seeded } from './test-support/fixtures';

function mailbox(id: string, domain: string, overrides: Partial<PairingMailbox> = {}): PairingMailbox {
  return { id, workspaceId: 'ws_1', domain, mailboxType: 'google', capacity: 10, ...overrides };
}

function freshState(cooling: string[] = []): PairingState {
  return createPairingState(new Map(), new Set(cooling));
}

/** Pick `n` recipients for `sender`, returning them in order. */
function pickMany(sender: PairingMailbox, pool: PairingMailbox[], n: number, state = freshState(), seed = 1) {
  const rng = seeded(seed);
  const picks: PairingMailbox[] = [];
  for (let i = 0; i < n; i++) {
    const pick = pickRecipient(sender, pool, state, rng);
    if (pick) picks.push(pick);
  }
  return picks;
}

describe('pickRecipient', () => {
  it('never picks a mailbox on the sender domain, nor the sender itself', () => {
    const sender = mailbox('a1', 'a.test');
    const pool = [sender, mailbox('a2', 'a.test'), mailbox('b1', 'b.test'), mailbox('c1', 'c.test')];
    for (const pick of pickMany(sender, pool, 60)) {
      expect(pick.domain).not.toBe('a.test');
      expect(pick.id).not.toBe('a1');
    }
  });

  it('returns null when everyone shares the sender domain', () => {
    const sender = mailbox('a1', 'a.test');
    expect(pickRecipient(sender, [sender, mailbox('a2', 'a.test')], freshState(), seeded(1))).toBeNull();
  });

  it('spreads the day over as many other domains as possible', () => {
    const sender = mailbox('a1', 'a.test');
    const pool = [
      sender,
      mailbox('b1', 'b.test'),
      mailbox('b2', 'b.test'),
      mailbox('c1', 'c.test'),
      mailbox('d1', 'd.test'),
      mailbox('e1', 'e.test'),
    ];
    const picks = pickMany(sender, pool, 8);
    // Four other domains: the first four messages go to four different domains.
    expect(new Set(picks.slice(0, 4).map((p) => p.domain)).size).toBe(4);
    const perDomain = new Map<string, number>();
    for (const pick of picks) perDomain.set(pick.domain, (perDomain.get(pick.domain) ?? 0) + 1);
    expect(Math.max(...perDomain.values()) - Math.min(...perDomain.values())).toBeLessThanOrEqual(1);
  });

  it('avoids a pair that had a thread within the cool-down while others are free', () => {
    const sender = mailbox('a1', 'a.test');
    const b1 = mailbox('b1', 'b.test');
    const b2 = mailbox('b2', 'b.test');
    const state = freshState([pairKey('a1', 'b1')]);
    const picks = pickMany(sender, [sender, b1, b2], 1, state);
    expect(picks[0]?.id).toBe('b2');
  });

  it('still picks a cooling pair when nobody else is left', () => {
    const sender = mailbox('a1', 'a.test');
    const b1 = mailbox('b1', 'b.test');
    const state = freshState([pairKey('a1', 'b1')]);
    expect(pickMany(sender, [sender, b1], 3, state).map((p) => p.id)).toEqual(['b1', 'b1', 'b1']);
  });

  it('prefers the other mailbox type', () => {
    const sender = mailbox('a1', 'a.test', { mailboxType: 'google' });
    const pool = [sender, mailbox('b1', 'b.test', { mailboxType: 'google' }), mailbox('c1', 'c.test', { mailboxType: 'shared' })];
    // Same fill and same domain use: the type decides the first pick.
    expect(pickMany(sender, pool, 1)[0]?.id).toBe('c1');
  });

  it('prefers another workspace', () => {
    const sender = mailbox('a1', 'a.test', { workspaceId: 'ws_1' });
    const pool = [
      sender,
      mailbox('b1', 'b.test', { workspaceId: 'ws_1' }),
      mailbox('c1', 'c.test', { workspaceId: 'ws_2' }),
    ];
    expect(pickMany(sender, pool, 1)[0]?.id).toBe('c1');
  });

  it('keeps received roughly equal to what a recipient sends', () => {
    // One mailbox sends 10 a day, the other 40. Over many senders' messages the
    // small one must not receive more than a little above its 10.
    const small = mailbox('s1', 's.test', { capacity: 10 });
    const big = mailbox('l1', 'l.test', { capacity: 40 });
    const senders = Array.from({ length: 30 }, (_, i) => mailbox(`x${i}`, `x${i}.test`, { capacity: 20 }));
    const pool = [small, big, ...senders];
    const state = freshState();
    const rng = seeded(5);
    for (const sender of senders) {
      for (let i = 0; i < 20; i++) pickRecipient(sender, pool, state, rng);
    }
    const receivedBySmall = state.received.get('s1') ?? 0;
    expect(receivedBySmall).toBeLessThanOrEqual(Math.ceil(10 * RECEIVE_HEADROOM) + 1);
    expect(state.received.get('l1') ?? 0).toBeGreaterThan(receivedBySmall);
  });

  it('falls back to a full recipient when every other one is over its headroom', () => {
    const sender = mailbox('a1', 'a.test');
    const b1 = mailbox('b1', 'b.test', { capacity: 2 });
    const state = createPairingState(new Map([['b1', 99]]), new Set());
    expect(pickRecipient(sender, [sender, b1], state, seeded(1))?.id).toBe('b1');
  });
});

describe('pickThreadId', () => {
  const ids = ['t1', 't2', 't3'];

  it('avoids threads the pair used recently', () => {
    const picked = new Set<string>();
    for (let seed = 1; seed < 40; seed++) picked.add(pickThreadId(ids, new Set(['t1', 't2']), new Map(), seeded(seed))!);
    expect([...picked]).toEqual(['t3']);
  });

  it('uses any thread when the pair has seen them all', () => {
    expect(ids).toContain(pickThreadId(ids, new Set(ids), new Map(), seeded(1)));
  });

  it('prefers the thread this run has used least', () => {
    const used = new Map([
      ['t1', 3],
      ['t2', 1],
      ['t3', 3],
    ]);
    expect(pickThreadId(ids, new Set(), used, seeded(1))).toBe('t2');
  });

  it('returns null for an empty corpus', () => {
    expect(pickThreadId([], new Set(), new Map(), seeded(1))).toBeNull();
  });
});
