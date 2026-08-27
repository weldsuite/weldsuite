import { describe, expect, it } from 'vitest';
import { extractEventSubscriptions } from '../../services/weldagent/subscriptions';
import { resolveAgentTools, agentHasGrants } from '../../services/weldagent/tools';

describe('extractEventSubscriptions', () => {
  it('returns manual when instructions have no triggers', () => {
    expect(extractEventSubscriptions('Help me write better emails.')).toEqual(['manual']);
  });

  it('extracts person.created from natural language', () => {
    const subs = extractEventSubscriptions(
      'When a new contact is created, research their company and notify sales.',
    );
    expect(subs).toContain('person.created');
  });

  it('extracts ticket.created', () => {
    const subs = extractEventSubscriptions('For each new ticket, summarise and triage.');
    expect(subs).toContain('ticket.created');
  });

  it('picks up explicit event keys', () => {
    const subs = extractEventSubscriptions('Listen for project_task.completed events.');
    expect(subs).toContain('project_task.completed');
  });
});

describe('resolveAgentTools', () => {
  it('filters tools by permission grants', () => {
    const tools = resolveAgentTools(['people:read', 'people:create']);
    const ids = tools.map((t) => t.id);
    expect(ids).toContain('people.list');
    expect(ids).toContain('people.create');
    expect(ids).not.toContain('tickets.create');
    expect(ids).not.toContain('tasks.create');
  });

  it('respects enabledTools allow-list', () => {
    const tools = resolveAgentTools(['people:read', 'people:create', 'tickets:read'], [
      'people.list',
    ]);
    expect(tools.map((t) => t.id)).toEqual(['people.list']);
  });

  it('agentHasGrants requires every required permission', () => {
    expect(agentHasGrants(['tickets:read'], ['tickets:read'])).toBe(true);
    expect(agentHasGrants(['tickets:read'], ['tickets:create'])).toBe(false);
    expect(agentHasGrants(['*'], ['tickets:create'])).toBe(true);
  });
});
