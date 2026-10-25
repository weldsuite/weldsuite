/**
 * Unit tests for the inbox list query builder (search keeps the other filters).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/welddesk-app/lib/desk-query.test.ts
 */
import { describe, expect, it } from 'vitest';
import { buildConversationQuery } from './desk-query';

describe('buildConversationQuery', () => {
  it('keeps state, assignee and sort alongside q', () => {
    const qs = buildConversationQuery({ state: 'open', unassigned: true, q: ' #42 ' }, 'newest');
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('q')).toBe('#42');
    expect(params.get('state')).toBe('open');
    expect(params.get('unassigned')).toBe('true');
    expect(params.get('sort')).toBe('newest');
  });

  it('omits q when blank', () => {
    expect(buildConversationQuery({ state: 'open', q: '   ' })).toBe('?state=open');
  });
});
