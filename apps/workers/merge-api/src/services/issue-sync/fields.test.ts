import { describe, expect, it } from 'vitest';
import { canonicalFields, checksumOf, providerStateToStatus, statusToProviderState } from './fields';

const base = { title: 'Fix tabs', body: 'Body', state: 'open' as const, stateReason: null, labels: ['bug'], assignee: 'octo' };

describe('canonical fields', () => {
  it('trims the title, normalises line endings, lower-cases and sorts labels and the assignee', () => {
    expect(
      canonicalFields({ ...base, title: '  Fix tabs  ', body: 'a\r\nb', labels: ['UI', 'Bug', 'ui'], assignee: 'Octo-Dev' }),
    ).toEqual({ title: 'Fix tabs', body: 'a\nb', state: 'open', stateReason: null, labels: ['bug', 'ui'], assignee: 'octo-dev' });
  });

  it('has no close reason while open, and a null body or assignee become empty and null', () => {
    expect(canonicalFields({ ...base, stateReason: 'completed', body: null, assignee: null })).toMatchObject({
      stateReason: null,
      body: '',
      assignee: null,
    });
    expect(canonicalFields({ ...base, state: 'closed', stateReason: 'not_planned' }).stateReason).toBe('not_planned');
  });
});

describe('checksumOf', () => {
  it('is the sha-256 hex of the canonical JSON, and every field changes it', async () => {
    const fields = canonicalFields(base);
    const sum = await checksumOf(fields);
    const expected = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('{"title":"Fix tabs","body":"Body","state":"open","stateReason":null,"labels":["bug"],"assignee":"octo"}'),
    );
    expect(sum).toBe(Array.from(new Uint8Array(expected), (b) => b.toString(16).padStart(2, '0')).join(''));
    for (const change of [
      { title: 'Other' },
      { body: 'Other' },
      { state: 'closed' as const, stateReason: 'completed' as const },
      { labels: ['bug', 'ui'] },
      { assignee: null },
    ]) {
      expect(await checksumOf(canonicalFields({ ...base, ...change }))).not.toBe(sum);
    }
  });

  it('is equal for the same state spelled differently', async () => {
    expect(await checksumOf(canonicalFields({ ...base, labels: ['BUG'], assignee: 'OCTO', title: ' Fix tabs' }))).toBe(await checksumOf(canonicalFields(base)));
  });
});

describe('status mapping', () => {
  it('maps WeldMerge statuses to the provider state', () => {
    expect(statusToProviderState('done')).toEqual({ state: 'closed', stateReason: 'completed' });
    expect(statusToProviderState('canceled')).toEqual({ state: 'closed', stateReason: 'not_planned' });
    for (const open of ['backlog', 'todo', 'in_progress', 'in_review'] as const) {
      expect(statusToProviderState(open)).toEqual({ state: 'open', stateReason: null });
    }
  });

  it('maps provider states to a status, keeping an open one and reopening to todo', () => {
    expect(providerStateToStatus({ state: 'closed', stateReason: 'completed' }, 'in_progress')).toBe('done');
    expect(providerStateToStatus({ state: 'closed', stateReason: 'not_planned' }, 'todo')).toBe('canceled');
    expect(providerStateToStatus({ state: 'open', stateReason: null }, 'done')).toBe('todo');
    expect(providerStateToStatus({ state: 'open', stateReason: null }, 'canceled')).toBe('todo');
    expect(providerStateToStatus({ state: 'open', stateReason: null }, 'in_review')).toBe('in_review');
    expect(providerStateToStatus({ state: 'open', stateReason: null }, null)).toBe('todo');
  });
});
