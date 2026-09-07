import { describe, expect, it } from 'vitest';
import { extractEventSubscriptions } from '../../services/weldagent/subscriptions';
import { resolveAgentTools, agentHasGrants } from '../../services/weldagent/tools';
import { agentNeedsSetup, toolsForAgentTurn } from '../../services/weldagent/executor';

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

  it('respects enabledTools allow-list but always includes save_agent_setup', () => {
    const tools = resolveAgentTools(['people:read', 'people:create', 'tickets:read'], [
      'people.list',
    ]);
    expect(tools.map((t) => t.id)).toEqual(['agent.save_setup', 'people.list']);
  });

  it('always exposes save_agent_setup even with no grants', () => {
    const tools = resolveAgentTools([]);
    expect(tools.map((t) => t.id)).toContain('agent.save_setup');
  });

  it('agentHasGrants requires every required permission', () => {
    expect(agentHasGrants(['tickets:read'], ['tickets:read'])).toBe(true);
    expect(agentHasGrants(['tickets:read'], ['tickets:create'])).toBe(false);
    expect(agentHasGrants(['*'], ['tickets:create'])).toBe(true);
  });
});

describe('setup interview gating', () => {
  it('detects empty system prompts as needing setup', () => {
    expect(agentNeedsSetup('')).toBe(true);
    expect(agentNeedsSetup('   ')).toBe(true);
    expect(agentNeedsSetup('Help with tickets daily')).toBe(false);
  });

  it('withholds save_agent_setup until the user has answered a follow-up', () => {
    const early = toolsForAgentTurn({
      permissions: [],
      enabledTools: [],
      systemPrompt: '',
      userMessageCount: 1,
    });
    expect(early.map((t) => t.id)).not.toContain('agent.save_setup');

    const ready = toolsForAgentTurn({
      permissions: [],
      enabledTools: [],
      systemPrompt: '',
      userMessageCount: 2,
    });
    expect(ready.map((t) => t.id)).toContain('agent.save_setup');
  });

  it('keeps save_agent_setup available once the agent already has instructions', () => {
    const tools = toolsForAgentTurn({
      permissions: [],
      enabledTools: [],
      systemPrompt: 'When a new ticket arrives, triage it.',
      userMessageCount: 1,
    });
    expect(tools.map((t) => t.id)).toContain('agent.save_setup');
  });
});
