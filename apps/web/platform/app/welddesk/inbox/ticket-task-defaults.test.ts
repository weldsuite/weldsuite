import { describe, it, expect } from 'vitest';
import type { DeskMessage } from '@/hooks/queries/use-desk-queries';
import { latestCustomerMessage, ticketTaskDefaults } from './ticket-task-defaults';

const labels = { latestCustomerMessage: 'Latest customer message' };

function message(id: string, authorType: DeskMessage['authorType'], body: string | null, kind: DeskMessage['kind'] = 'message'): DeskMessage {
  return {
    id,
    createdAt: '2026-11-07T10:00:00.000Z',
    conversationId: 'dconv_1',
    kind,
    body,
    authorType,
    authorId: null,
    attachments: null,
    metadata: null,
  };
}

const conversation = { conversationNumber: 42, title: 'Refund not received', name: 'Jane', email: 'jane@example.com' };

describe('ticketTaskDefaults', () => {
  it('titles the task with the number and subject, and quotes the latest customer message', () => {
    const messages = [
      message('m1', 'visitor', 'Where is my refund?'),
      message('m2', 'agent', 'Looking into it'),
      message('m3', 'visitor', 'Still nothing.\nOrder 1234'),
      message('m4', 'agent', 'internal', 'note'),
    ];
    expect(ticketTaskDefaults(conversation, messages, labels)).toEqual({
      title: '#42 Refund not received',
      description: 'Latest customer message:\n\nStill nothing.\nOrder 1234',
    });
  });

  it('uses the first line of the latest customer message when there is no subject', () => {
    const messages = [message('m1', 'visitor', '\n  My invoice is wrong  \nIt says 2025')];
    expect(ticketTaskDefaults({ ...conversation, title: null }, messages, labels).title).toBe('#42 My invoice is wrong');
  });

  it('falls back to the customer, and leaves the description empty without a customer message', () => {
    const result = ticketTaskDefaults({ ...conversation, title: '  ' }, [message('m1', 'agent', 'Hi')], labels);
    expect(result).toEqual({ title: '#42 Jane', description: '' });
  });

  it('keeps the title within the 500 characters a task allows', () => {
    const result = ticketTaskDefaults({ ...conversation, title: 'x'.repeat(600) }, [], labels);
    expect(result.title).toHaveLength(500);
  });
});

describe('latestCustomerMessage', () => {
  it('skips events, notes, agents and empty bodies', () => {
    const messages = [
      message('m1', 'visitor', 'First'),
      message('m2', 'visitor', '   '),
      message('m3', 'visitor', null, 'event'),
      message('m4', 'agent', 'Reply'),
    ];
    expect(latestCustomerMessage(messages)?.id).toBe('m1');
  });
});
