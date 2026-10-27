import { describe, expect, it } from 'vitest';
import { describeEvent, type EventLabels } from './event-labels';

const labels: EventLabels = {
  scheduled: 'On a schedule',
  manual: 'Only when asked',
  when: 'When {article} {entity} {action}',
  articleA: 'a',
  articleAn: 'an',
  entities: { project_task: 'task', email: 'email', ticket: 'ticket' },
  actions: { created: 'is created', received: 'is received', completed: 'is completed' },
};

describe('describeEvent', () => {
  it('phrases entity events', () => {
    expect(describeEvent('project_task.created', labels)).toBe('When a task is created');
    expect(describeEvent('ticket.created', labels)).toBe('When a ticket is created');
  });

  it('uses "an" before a vowel', () => {
    expect(describeEvent('email.received', labels)).toBe('When an email is received');
  });

  it('names the schedule and manual markers', () => {
    expect(describeEvent('scheduled', labels)).toBe('On a schedule');
    expect(describeEvent('manual', labels)).toBe('Only when asked');
  });

  it('humanizes an entity it has no noun for', () => {
    expect(describeEvent('sales_order.completed', labels)).toBe('When a sales order is completed');
  });

  it('falls back to the key it cannot phrase', () => {
    expect(describeEvent('ticket.exploded', labels)).toBe('ticket.exploded');
    expect(describeEvent('whatever', labels)).toBe('whatever');
  });
});
