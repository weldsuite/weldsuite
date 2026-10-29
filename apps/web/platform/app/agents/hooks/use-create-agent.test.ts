import { describe, expect, it } from 'vitest';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { draftCandidates, findUntouchedDraft } from './use-create-agent';

function agent(id: string, patch: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id,
    name: 'Untitled agent',
    description: null,
    icon: null,
    status: 'draft',
    systemPrompt: '',
    modelId: 'claude-opus-5-5',
    temperature: '0.7',
    maxTokens: 4096,
    permissions: [],
    enabledTools: [],
    eventSubscriptions: [],
    maxIterations: 10,
    maxTotalTokens: 50000,
    createdBy: 'user_me',
    ownerId: 'user_me',
    visibility: 'private',
    subagentIds: [],
    delegateToSelf: false,
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    ...patch,
  };
}

describe('draftCandidates', () => {
  it('keeps the own drafts that still need setup, newest first', () => {
    const agents = [
      agent('old', { createdAt: '2026-10-01T10:00:00Z' }),
      agent('new', { createdAt: '2026-10-20T10:00:00Z' }),
      agent('done', { systemPrompt: 'Triage tickets', status: 'active' }),
      agent('theirs', { createdBy: 'user_other' }),
      agent('live-but-empty', { status: 'active' }),
    ];
    expect(draftCandidates(agents, 'user_me').map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('looks at a handful of drafts at most', () => {
    const agents = ['a', 'b', 'c', 'd', 'e'].map((id, i) => agent(id, { createdAt: `2026-10-0${i + 1}T10:00:00Z` }));
    expect(draftCandidates(agents, 'user_me')).toHaveLength(3);
  });
});

describe('findUntouchedDraft', () => {
  it('returns the first draft without messages', async () => {
    const counts: Record<string, number> = { a: 4, b: 0, c: 0 };
    const found = await findUntouchedDraft([agent('a'), agent('b'), agent('c')], async (id) => counts[id]);
    expect(found?.id).toBe('b');
  });

  it('returns null when every draft was started', async () => {
    expect(await findUntouchedDraft([agent('a')], async () => 2)).toBeNull();
  });
});
