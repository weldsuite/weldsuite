import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS as ENTITY_EVENT_CATALOG } from '@weldsuite/entity-events';
import { validateWeldConnectWorkflow } from '../../services/weldconnect-mvp';
import { ENTITY_EVENTS } from './static-catalogs';

const emailStep = {
  id: 'step-1',
  type: 'send_email',
  config: { to: 'a@example.com', subject: 'Hi', body: '<p>Hi</p>' },
};

describe('entity event trigger catalog', () => {
  it('offers current CRM objects and no commerce or retired CRM objects', () => {
    const offered = ENTITY_EVENTS.map((entry) => entry.entityType);
    expect(offered).toEqual(expect.arrayContaining(['company', 'person', 'opportunity']));
    expect(offered).not.toContain('lead');
    expect(offered).not.toContain('commerce_order');
    expect(offered).not.toContain('product');
    expect(ENTITY_EVENTS.map((entry) => entry.category)).not.toContain('Commerce');
  });

  it('labels the opportunity object as a Deal', () => {
    expect(ENTITY_EVENTS.find((entry) => entry.entityType === 'opportunity')?.label).toBe('Deal');
  });

  it('only offers entity types that exist in the entity-events catalog', () => {
    for (const entry of ENTITY_EVENTS) {
      expect(Object.keys(ENTITY_EVENT_CATALOG)).toContain(entry.entityType);
      expect(entry.events.length).toBeGreaterThan(0);
    }
  });

  it('every offered entity/event pair passes the activation gate', () => {
    for (const entry of ENTITY_EVENTS) {
      for (const event of entry.events) {
        const issues = validateWeldConnectWorkflow({
          triggers: [{ id: 't1', type: 'entity_event', entityType: entry.entityType, eventType: event.id }],
          steps: [emailStep],
        });
        expect(issues, `${entry.entityType}:${event.id}`).toEqual([]);
      }
    }
  });
});
