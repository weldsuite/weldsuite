/**
 * The pure parts of the help-center requests: which status group a
 * conversation shows, which form fields a type offers, and when a
 * conditional field is shown.
 */

import { describe, expect, it } from 'vitest';
import type { HelpdeskTicketType } from '../schema/helpdesk-ticket-types';
import { deskPortalStatus, deskPortalStatusLabel, isDeskPortalFieldShown, toDeskPortalRequestType } from './desk-portal';

const at = new Date('2026-10-31T10:00:00Z');

describe('deskPortalStatus', () => {
  it.each([
    [{ state: 'closed', waitingSince: null, lastMessageAt: at, assigneeId: 'u' }, 'resolved'],
    [{ state: 'open', waitingSince: null, lastMessageAt: at, assigneeId: 'u' }, 'waiting_on_customer'],
    [{ state: 'open', waitingSince: at, lastMessageAt: at, assigneeId: 'u' }, 'in_progress'],
    [{ state: 'open', waitingSince: at, lastMessageAt: at, assigneeId: null }, 'submitted'],
  ] as const)('%o → %s', (conversation, status) => {
    expect(deskPortalStatus(conversation)).toBe(status);
  });

  it("uses the type's customer wording when it has one", () => {
    const type = { states: [{ groupKey: 'resolved', groupLabel: 'Done', customerGroupLabel: 'Sorted', states: [] }] } as Pick<HelpdeskTicketType, 'states'>;
    expect(deskPortalStatusLabel(type, 'resolved')).toBe('Sorted');
    expect(deskPortalStatusLabel(type, 'submitted')).toBeNull();
  });
});

describe('toDeskPortalRequestType', () => {
  it('keeps the customer-visible, non-default fields in order and takes the title and description labels', () => {
    const form = toDeskPortalRequestType({
      id: 'tt_1',
      name: 'Bug',
      description: null,
      icon: null,
      color: null,
      fields: [
        { key: 'b', label: 'B', type: 'text', required: false, order: 3 },
        { key: 'title', label: 'Summary', type: 'text', required: true, order: 0, isDefault: true },
        { key: 'description', label: 'Steps', type: 'textarea', required: false, order: 1, isDefault: true, customerVisible: false },
        { key: 'a', label: 'A', type: 'text', required: true, order: 2 },
        { key: 'secret', label: 'S', type: 'text', required: false, order: 4, customerVisible: false },
      ],
    } as HelpdeskTicketType);
    expect(form.titleLabel).toBe('Summary');
    expect(form.descriptionLabel).toBeNull();
    expect(form.fields.map((f) => f.key)).toEqual(['a', 'b']);
  });
});

describe('isDeskPortalFieldShown', () => {
  const field = (operator: 'equals' | 'not_equals' | 'is_set' | 'is_not_set', value?: string) => ({
    conditions: [{ field: 'kind', operator, value }],
  });

  it('applies each operator to the answer so far', () => {
    expect(isDeskPortalFieldShown(field('equals', 'x'), { kind: 'x' })).toBe(true);
    expect(isDeskPortalFieldShown(field('equals', 'x'), { kind: ['y', 'x'] })).toBe(true);
    expect(isDeskPortalFieldShown(field('not_equals', 'x'), { kind: 'x' })).toBe(false);
    expect(isDeskPortalFieldShown(field('is_set'), { kind: '' })).toBe(false);
    expect(isDeskPortalFieldShown(field('is_not_set'), {})).toBe(true);
    expect(isDeskPortalFieldShown({ conditions: [] }, {})).toBe(true);
  });
});
