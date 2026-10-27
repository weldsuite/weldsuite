import { describe, expect, it } from 'vitest';
import {
  EXPLICIT_TRIGGERS_FLAG,
  extractEventSubscriptions,
  hasExplicitTriggers,
  normalizeExplicitTriggers,
  withExplicitTriggersFlag,
} from './subscriptions';
import { resolveAgentTools, agentHasGrants } from './tools';
import { agentNeedsSetup, toolsForAgentTurn } from './executor';

describe('extractEventSubscriptions', () => {
  it('returns manual when instructions have no triggers', () => {
    expect(extractEventSubscriptions('Help me write better emails.')).toEqual(['manual']);
  });

  describe('negation and requests are not triggers (chat-only agents stay manual)', () => {
    it.each([
      'You have no schedules or automatic triggers.',
      'You have no schedules or automatic triggers; you only work when asked in chat.',
      'Do not create new tasks unless asked.',
      'Never open new tickets yourself',
      "Don't create new people or companies on your own.",
      'When the user asks in chat, create a new person in the CRM.',
      'Create a new person in the CRM when the user asks.',
      'Only create a new ticket if the user requests it.',
      'If someone asks, open a new task for them.',
      'You never run on a schedule.',
      'You can create a new ticket for the user. You cannot react to new tickets by yourself.',
    ])('%s', (instructions) => {
      expect(extractEventSubscriptions(instructions)).toEqual(['manual']);
    });

    it('keeps a chat-only prompt manual as a whole', () => {
      const prompt = [
        'You are the CRM QA Assistant.',
        'You answer questions about contacts in chat.',
        'You have no schedules or automatic triggers.',
        'Do not create new tasks unless asked.',
        'Never open new tickets yourself.',
        'When the user asks in chat, create a new person in the CRM.',
      ].join('\n');
      expect(extractEventSubscriptions(prompt)).toEqual(['manual']);
    });
  });

  describe('real triggers still work', () => {
    it('subscribes to new tickets', () => {
      expect(extractEventSubscriptions('Whenever a new ticket comes in, triage it.')).toEqual(['ticket.created']);
    });

    it('reads a real schedule', () => {
      expect(extractEventSubscriptions('Every morning at 8, send a digest of overdue tasks.')).toEqual(['scheduled']);
      expect(extractEventSubscriptions('Send the sales summary daily.')).toEqual(['scheduled']);
      expect(extractEventSubscriptions('Run on a schedule and tidy the pipeline.')).toEqual(['scheduled']);
    });

    it.each([
      ['A new ticket arrives', 'ticket.created'],
      ['When a ticket is created, assign it', 'ticket.created'],
      ['Triage incoming tickets', 'ticket.created'],
      ['For each new person, enrich their profile', 'person.created'],
      ['On every new lead, send a welcome note', 'lead.created'],
      ['When a ticket is resolved, send a survey', 'ticket.resolved'],
      ['When a task is completed, notify the project manager', 'project_task.completed'],
      ['When an invoice is overdue, remind the customer', 'invoice.overdue'],
      ['Whenever a deal is won, congratulate the owner', 'opportunity.won'],
    ])('%s', (instructions, event) => {
      expect(extractEventSubscriptions(instructions)).toEqual([event]);
    });

    it('does not treat the agent creating a record in reaction to another as a trigger', () => {
      // The trigger is the new person; the ticket is what the agent creates.
      expect(extractEventSubscriptions('Whenever a new person is added, create a new ticket for onboarding.')).toEqual([
        'person.created',
      ]);
    });

    it('drops the schedule marker next to a real event', () => {
      expect(
        extractEventSubscriptions('When a new ticket arrives, triage it. Every morning, summarise the open ones.'),
      ).toEqual(['ticket.created']);
    });

    it('does not count the agent creating something for itself ("when you create a new task")', () => {
      expect(extractEventSubscriptions('When you create a new task, link it to the project.')).toEqual(['manual']);
    });

    it('keeps a trigger whose clause is next to a negated one', () => {
      expect(
        extractEventSubscriptions('When a new ticket arrives, triage it, but never close it yourself.'),
      ).toEqual(['ticket.created']);
    });

    it('ignores event keys the catalog does not know', () => {
      expect(extractEventSubscriptions('React to widgets.created events.')).toEqual(['manual']);
    });
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

describe('explicit triggers', () => {
  it('keeps catalog events, accepts the colon form, and de-duplicates', () => {
    expect(normalizeExplicitTriggers(['ticket.created', 'Ticket:Created', 'person.created'])).toEqual({
      subscriptions: ['ticket.created', 'person.created'],
      invalid: [],
    });
  });

  it('reports what the catalog does not know and refuses the wildcard', () => {
    expect(normalizeExplicitTriggers(['widget.created', '*', 'ticket.created'])).toEqual({
      subscriptions: ['ticket.created'],
      invalid: ['widget.created', '*'],
    });
  });

  it('means chat only when nothing real is left', () => {
    expect(normalizeExplicitTriggers([])).toEqual({ subscriptions: ['manual'], invalid: [] });
    expect(normalizeExplicitTriggers(['manual'])).toEqual({ subscriptions: ['manual'], invalid: [] });
    expect(normalizeExplicitTriggers(['nonsense'])).toEqual({ subscriptions: ['manual'], invalid: ['nonsense'] });
  });

  it('flags an agent whose subscriptions were given explicitly', () => {
    expect(hasExplicitTriggers(['people.list'])).toBe(false);
    const flagged = withExplicitTriggersFlag(['people.list', 'agent.auto_review']);
    expect(flagged).toEqual(['people.list', 'agent.auto_review', EXPLICIT_TRIGGERS_FLAG]);
    expect(hasExplicitTriggers(flagged)).toBe(true);
    expect(withExplicitTriggersFlag(flagged)).toEqual(flagged);
    // The flag is not a tool: it must not become an allow-list.
    expect(resolveAgentTools(['people:read'], flagged).some((t) => t.id === 'people.list')).toBe(true);
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

  it('respects enabledTools allow-list but always includes ask/setup/skill/memory/routine tools', () => {
    const tools = resolveAgentTools(['people:read', 'people:create', 'tickets:read'], [
      'people.list',
    ]);
    expect(tools.map((t) => t.id)).toEqual([
      'agent.save_setup',
      'agent.ask_user',
      'agent.list_routines',
      'agent.update_routine',
      'agent.save_skill',
      'agent.remember',
      'agent.create_routine',
      'people.list',
    ]);
  });

  it('always exposes save_agent_setup even with no grants', () => {
    const tools = resolveAgentTools([]);
    expect(tools.map((t) => t.id)).toContain('agent.save_setup');
    expect(tools.map((t) => t.id)).toContain('agent.save_skill');
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

  it('only lets the interview ask until the user has answered a follow-up', () => {
    const early = toolsForAgentTurn({
      permissions: ['people:read', 'computer:use'],
      enabledTools: [],
      systemPrompt: '',
      userMessageCount: 1,
    });
    expect(early.map((t) => t.id)).toEqual(['agent.ask_user']);

    const ready = toolsForAgentTurn({
      permissions: ['people:read', 'computer:use'],
      enabledTools: [],
      systemPrompt: '',
      userMessageCount: 2,
    });
    expect(ready.map((t) => t.id).sort()).toEqual(['agent.ask_user', 'agent.save_setup']);
  });

  it('keeps platform tools once the agent already has instructions', () => {
    const tools = toolsForAgentTurn({
      permissions: ['people:read'],
      enabledTools: [],
      systemPrompt: 'When a new ticket arrives, triage it.',
      userMessageCount: 1,
    });
    expect(tools.map((t) => t.id)).toContain('agent.save_setup');
    expect(tools.map((t) => t.id)).toContain('agent.save_skill');
    expect(tools.map((t) => t.id)).toContain('people.list');
  });
});
