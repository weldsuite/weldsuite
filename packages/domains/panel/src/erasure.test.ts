import { describe, expect, it } from 'vitest';
import { PANEL_ERASE_MAX_IDS, eraseMessages, panelEraseMessageSchema } from './erasure';

const base = { workspaceId: 'ws_a', projectId: 'pnp_1' };

describe('erasure queue messages', () => {
  it('accepts what panel-api sends and refuses what the consumer cannot use', () => {
    expect(panelEraseMessageSchema.safeParse({ type: 'erase', ...base, ids: ['u1'] }).success).toBe(true);
    expect(panelEraseMessageSchema.safeParse({ type: 'wipe', ...base, ids: ['u1'] }).success).toBe(false);
    expect(panelEraseMessageSchema.safeParse({ type: 'erase', ...base, ids: [] }).success).toBe(false);
    expect(panelEraseMessageSchema.safeParse({ type: 'erase', ...base, ids: [''] }).success).toBe(false);
    expect(panelEraseMessageSchema.safeParse({ type: 'erase', ...base, ids: Array.from({ length: PANEL_ERASE_MAX_IDS + 1 }, (_, i) => `u${i}`) }).success).toBe(false);
  });

  it('splits a large erasure into messages the consumer accepts, without duplicates or empty ids', () => {
    const ids = Array.from({ length: PANEL_ERASE_MAX_IDS * 2 + 5 }, (_, i) => `u${i}`);
    const messages = eraseMessages({ ...base, ids: [...ids, 'u0', ''] });

    expect(messages.map((m) => m.ids.length)).toEqual([PANEL_ERASE_MAX_IDS, PANEL_ERASE_MAX_IDS, 5]);
    for (const message of messages) expect(panelEraseMessageSchema.safeParse(message).success).toBe(true);
    expect(eraseMessages({ ...base, ids: [] })).toEqual([]);
  });
});
