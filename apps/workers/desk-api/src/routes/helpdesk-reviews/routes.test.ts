/**
 * Every /api/helpdesk-reviews route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskReviewsRoutes } from './index';

describeCrud('/api/helpdesk-reviews', {
  base: '/api/helpdesk-reviews',
  routes: helpdeskReviewsRoutes,
  table: schema.helpdeskReviews,
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({
    title: `Review ${n}`,
    content: 'Good',
    rating: 5,
    reviewerId: 'r',
    reviewerName: 'R',
    reviewerEmail: 'r@x.test',
  }),
  valid: {
    title: 'Great',
    content: 'Great support',
    rating: 5,
    reviewerId: 'r',
    reviewerName: 'R',
    reviewerEmail: 'r@x.test',
    ticketId: null,
  },
  unstorable: { title: 'No content', rating: 3 },
  invalid: [{ title: 'x', rating: 9 }, { title: 'x', customerEmail: 'bad' }, { title: 'x', ticketId: 4 }],
  patch: { title: 'Great!', isPinned: true },
  invalidPatch: { isPublished: 'no' },
  filters: [{ query: 'search=Needle', match: { title: 'Needle review' } }],
});
