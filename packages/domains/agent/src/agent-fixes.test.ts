import { describe, it, expect } from 'vitest';
import { resolveAgentTools, effectiveAgentPermissions, explicitToolAllowList } from './tools';
import { computeRoutineNextRun, toolRiskLevel, allowsAutoReview } from './parity';
import { toModelHistory } from './complete-turn';

describe('resolveAgentTools', () => {
  it('ignores non-tool flags in enabledTools (auto-review must not strip tools)', () => {
    const tools = resolveAgentTools(['people:read'], ['agent.auto_review']);
    expect(tools.some((t) => t.id === 'people.list')).toBe(true);
    expect(explicitToolAllowList(['agent.auto_review'])).toEqual([]);
  });

  it('still honours a real allow-list', () => {
    const tools = resolveAgentTools(['people:read', 'tickets:read'], ['tickets.list', 'agent.auto_review']);
    expect(tools.some((t) => t.id === 'tickets.list')).toBe(true);
    expect(tools.some((t) => t.id === 'people.list')).toBe(false);
  });
});

describe('effectiveAgentPermissions', () => {
  it('returns agent grants for unattended runs', () => {
    expect(effectiveAgentPermissions(['people:create'], undefined)).toEqual(['people:create']);
  });

  it('never exceeds the acting user', () => {
    expect(effectiveAgentPermissions(['people:create', 'people:read'], ['people:read'])).toEqual([
      'people:read',
    ]);
  });

  it('intersects wildcards to the narrower side', () => {
    expect(effectiveAgentPermissions(['people:*'], ['people:read'])).toEqual(['people:read']);
    expect(effectiveAgentPermissions(['people:read'], ['*'])).toEqual(['people:read']);
  });

  it('intersects with per-app user grants', () => {
    // Agent grants are unqualified; a user's may be granted per app.
    const effective = effectiveAgentPermissions(['people:read', 'people:create'], ['weldcrm:people:read']);
    expect(effective).toContain('people:read');
    expect(effective).not.toContain('people:create');
    expect(effectiveAgentPermissions(['people:*'], ['weldcrm:people:read'])).toEqual(['weldcrm:people:read']);
  });
});

describe('computeRoutineNextRun', () => {
  it('honours the cron expression instead of always bumping one hour', () => {
    const from = new Date('2026-01-05T10:30:00Z'); // Monday
    const next = computeRoutineNextRun('0 9 * * 1', 'UTC', from);
    expect(next.toISOString()).toBe('2026-01-12T09:00:00.000Z');
  });

  it('applies the routine timezone', () => {
    const from = new Date('2026-01-05T00:00:00Z');
    const next = computeRoutineNextRun('0 9 * * *', 'Europe/Amsterdam', from);
    expect(next.toISOString()).toBe('2026-01-05T08:00:00.000Z');
  });

  it('falls back to the next hour on a malformed expression', () => {
    const next = computeRoutineNextRun('nonsense', 'UTC', new Date('2026-01-05T10:30:00Z'));
    expect(next.toISOString()).toBe('2026-01-05T11:00:00.000Z');
  });
});

describe('toModelHistory', () => {
  it('replays tool results so the model remembers ids across turns', () => {
    const now = new Date();
    const rows = [
      { id: 'm1', role: 'user', content: 'find Ann', toolInvocations: null },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Found Ann.',
        toolInvocations: [
          { toolName: 'list_people', state: 'call', args: {} },
          { toolName: 'list_people', state: 'result', args: {}, result: { people: [{ id: 'per_1' }] } },
        ],
      },
      { id: 'm3', role: 'system', content: 'ignored', toolInvocations: null },
    ].map((r) => ({ ...r, conversationId: 'c', formState: null, metadata: null, createdAt: now, updatedAt: now, deletedAt: null }));

    const history = toModelHistory(rows as never);
    expect(history).toHaveLength(2);
    expect(history[1].content).toContain('list_people');
    expect(history[1].content).toContain('per_1');
  });
});

describe('approval gate', () => {
  it('treats mutating browser actions as high risk, read-only ones as low', () => {
    expect(toolRiskLevel('browser_act', { action: 'click' })).toBe('high');
    expect(toolRiskLevel('browser_act', { action: 'type' })).toBe('high');
    expect(toolRiskLevel('browser_act', { action: 'extract' })).toBe('low');
    expect(toolRiskLevel('browser_open', { url: 'https://example.com' })).toBe('low');
  });

  it('never lets one past approval auto-approve arbitrary code or browser input', () => {
    expect(allowsAutoReview('computer_exec')).toBe(false);
    expect(allowsAutoReview('computer_run_code')).toBe(false);
    expect(allowsAutoReview('browser_act')).toBe(false);
    expect(allowsAutoReview('create_task')).toBe(true);
  });
});
