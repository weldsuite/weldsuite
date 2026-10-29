/**
 * Every /api/ticket-messages route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud, seedTickets } from '../../test/crud-suite';
import { ticketMessagesRoutes } from './index';

describeCrud('/api/ticket-messages', {
  base: '/api/ticket-messages',
  routes: ticketMessagesRoutes,
  table: schema.helpdeskTicketMessages,
  setup: (db) => seedTickets(db, ['tkt_seed', 'tkt_filter', 'tkt_1']),
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({
    ticketId: 'tkt_seed',
    authorName: 'A',
    authorEmail: 'a@x.test',
    body: `Message ${n}`,
    subject: `Subject ${n}`,
  }),
  valid: {
    ticketId: 'tkt_1',
    subject: 'Hi',
    body: 'Hello',
    authorName: 'A',
    authorEmail: 'a@x.test',
    authorType: 'agent',
    direction: 'outbound',
  },
  unstorable: { ticketId: 'tkt_1', body: 'no author' },
  invalid: [
    { body: 'no ticket' },
    { ticketId: 'x', authorType: 'robot' },
    { ticketId: 'x', authorEmail: 'bad' },
    { ticketId: 'x', direction: 'up' },
  ],
  patch: { subject: 'Re: Hi', isInternal: true },
  invalidPatch: { direction: 'sideways' },
  filters: [
    { query: 'ticketId=tkt_filter', match: { ticketId: 'tkt_filter' } },
    { query: 'authorId=user_filter', match: { authorId: 'user_filter' } },
    { query: 'search=Needle', match: { subject: 'A Needle subject' } },
  ],
});
