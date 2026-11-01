/**
 * Every /api/ticket-notes route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud, seedTickets } from '../../test/crud-suite';
import { ticketNotesRoutes } from './index';

describeCrud('/api/ticket-notes', {
  base: '/api/ticket-notes',
  routes: ticketNotesRoutes,
  table: schema.helpdeskTicketNotes,
  setup: (db) => seedTickets(db, ['tkt_seed', 'tkt_filter', 'tkt_1']),
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({ ticketId: 'tkt_seed', authorId: 'user_a', authorName: 'A', content: `Note ${n}` }),
  valid: { ticketId: 'tkt_1', authorId: 'user_a', authorName: 'A', body: 'body is not a column', content: 'Called them' },
  unstorable: { ticketId: 'tkt_1', body: 'no author' },
  invalid: [{ body: 'no ticket' }, { ticketId: 'tkt_1' }, { ticketId: 'tkt_1', body: 'x', mentions: 'u' }],
  patch: { content: 'Called them back', isImportant: true },
  invalidPatch: { authorName: 'x'.repeat(256) },
  filters: [
    { query: 'ticketId=tkt_filter', match: { ticketId: 'tkt_filter' } },
    { query: 'authorId=user_filter', match: { authorId: 'user_filter' } },
  ],
});

it('exports the router the suite mounts', () => {
  expect(ticketNotesRoutes.routes.length).toBeGreaterThan(0);
});
