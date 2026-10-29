/**
 * Every /api/helpdesk-feedback route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskFeedbackRoutes } from './index';

describeCrud('/api/helpdesk-feedback', {
  base: '/api/helpdesk-feedback',
  routes: helpdeskFeedbackRoutes,
  table: schema.helpdeskFeedback,
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({ title: `Idea ${n}`, description: 'More', submitterId: 'u', submitterName: 'U', submitterEmail: 'u@x.test' }),
  valid: {
    title: 'Dark mode',
    description: 'Please',
    submitterId: 'u',
    submitterName: 'U',
    submitterEmail: 'u@x.test',
    rating: 4,
  },
  unstorable: { title: 'Missing submitter', rating: 2 },
  invalid: [
    { title: 'x', rating: 6 },
    { title: 'x', rating: 0 },
    { title: 'x', customerEmail: 'nope' },
    { title: 'x', type: 'x'.repeat(51) },
  ],
  patch: { title: 'Dark mode, please', status: 'planned' },
  invalidPatch: { rating: 2.5 },
  filters: [{ query: 'search=Needle', match: { title: 'Needle request' } }],
});
