import { describe, expect, it } from 'vitest';
import { getLegacyEntityOption, getLegacyEventOption } from './legacy-entity-options';
import { summarizeTrigger, type NodeSummaryLabels } from './node-summary';

const template = '{name} (legacy)';
const entities = [
  { entityType: 'project_task', label: 'Task', events: [{ id: 'created', name: 'Task Created' }, { id: 'updated', name: 'Task Updated' }] },
  { entityType: 'ticket', label: 'Ticket', events: ['created'] },
];

describe('getLegacyEntityOption', () => {
  it('offers a saved entity type that is no longer in the list', () => {
    expect(getLegacyEntityOption('commerce_order', entities, template)).toEqual({
      value: 'commerce_order',
      label: 'Commerce order (legacy)',
    });
    expect(getLegacyEntityOption('lead', entities, template)).toEqual({ value: 'lead', label: 'Lead (legacy)' });
  });

  it('adds nothing for an offered or empty entity type', () => {
    expect(getLegacyEntityOption('project_task', entities, template)).toBeNull();
    expect(getLegacyEntityOption('', entities, template)).toBeNull();
  });
});

describe('getLegacyEventOption', () => {
  it('offers a saved event the entity no longer has, or whose entity is gone', () => {
    expect(getLegacyEventOption('project_task', 'archived', entities, template)).toEqual({
      value: 'archived',
      label: 'Archived (legacy)',
    });
    expect(getLegacyEventOption('lead', 'qualified', entities, template)).toEqual({
      value: 'qualified',
      label: 'Qualified (legacy)',
    });
  });

  it('adds nothing for an offered or empty event', () => {
    expect(getLegacyEventOption('project_task', 'created', entities, template)).toBeNull();
    expect(getLegacyEventOption('ticket', 'created', entities, template)).toBeNull();
    expect(getLegacyEventOption('project_task', '', entities, template)).toBeNull();
  });
});

describe('trigger summary for a legacy entity type', () => {
  const labels = { configured: '', to: '', delay: '', entity: '', trigger: {} } as unknown as NodeSummaryLabels;

  it('still reads naturally', () => {
    expect(
      summarizeTrigger(
        { type: 'entity_event', entityType: 'commerce_order', eventType: 'placed' },
        { labels, entityEvents: entities, cronPresets: [], workflows: [], integrationTriggers: [], locale: 'en' },
      ),
    ).toBe('Commerce order placed');
  });
});
