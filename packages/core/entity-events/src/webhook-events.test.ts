import { describe, expect, it } from 'vitest';
import {
  legacyWebhookEventNames,
  listWebhookEvents,
  subscribedWebhookEventName,
} from './webhook-events';
import { listAllEvents } from './events';

describe('listWebhookEvents', () => {
  it('leaves out the legacy CRM names and keeps the current ones', () => {
    const events = listWebhookEvents();
    expect(events.some((e) => e.startsWith('customer.'))).toBe(false);
    expect(events.some((e) => e.startsWith('contact.'))).toBe(false);
    expect(events).toContain('company.created');
    expect(events).toContain('person.created');
    // Similar-looking but distinct entity types stay.
    expect(events).toContain('customer_list.created');
    expect(events).toContain('contact_link.created');
  });

  it('only drops the legacy entries from the full catalog', () => {
    const dropped = listAllEvents().filter((e) => !listWebhookEvents().includes(e));
    expect(dropped.every((e) => e.startsWith('customer.') || e.startsWith('contact.'))).toBe(true);
  });
});

describe('legacy subscriptions', () => {
  it('maps a current event to the legacy names a webhook may still list', () => {
    expect(legacyWebhookEventNames('company.created')).toEqual(['customer.created']);
    expect(legacyWebhookEventNames('person.updated')).toEqual(['contact.updated']);
    // contact has no `unarchived` action, so nothing to alias.
    expect(legacyWebhookEventNames('person.unarchived')).toEqual([]);
    expect(legacyWebhookEventNames('ticket.created')).toEqual([]);
  });

  it('delivers under the name the webhook subscribed to', () => {
    expect(subscribedWebhookEventName(['company.created'], 'company.created')).toBe('company.created');
    expect(subscribedWebhookEventName(['customer.created'], 'company.created')).toBe('customer.created');
    expect(subscribedWebhookEventName(['customer.created', 'company.created'], 'company.created')).toBe(
      'company.created',
    );
    expect(subscribedWebhookEventName(['ticket.created'], 'company.created')).toBeNull();
  });
});
