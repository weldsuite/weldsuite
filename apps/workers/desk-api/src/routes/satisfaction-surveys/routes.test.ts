/**
 * Every /api/satisfaction-surveys route on pglite, through the shared CRUD
 * suite (../../test/crud-suite.ts); runs against Rust in conformance mode.
 *
 * No create succeeds: `sent_at` is NOT NULL without a default, and the
 * schema can only hand it a string, which Drizzle's timestamp refuses.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud, seedTickets } from '../../test/crud-suite';
import { satisfactionSurveysRoutes } from './index';

describeCrud('/api/satisfaction-surveys', {
  base: '/api/satisfaction-surveys',
  routes: satisfactionSurveysRoutes,
  table: schema.helpdeskSatisfactionSurveys,
  setup: (db) => seedTickets(db, ['tkt_seed', 'tkt_filter', 'tkt_1']),
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({ ticketId: 'tkt_seed', customerId: 'cus_seed', sentAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)) }),
  unstorable: { ticketId: 'tkt_1', customerId: 'cus_1', rating: 4 },
  invalid: [{ rating: 0 }, { rating: 6 }, { status: 'x'.repeat(21) }, { ticketId: 9 }],
  patch: { rating: 5, comment: 'Great', status: 'completed' },
  invalidPatch: { rating: 'five' },
  filters: [
    { query: 'ticketId=tkt_filter', match: { ticketId: 'tkt_filter' } },
    { query: 'customerId=cus_filter', match: { customerId: 'cus_filter' } },
    { query: 'status=answered', match: { status: 'answered' } },
  ],
});
