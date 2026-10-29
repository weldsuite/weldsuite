/**
 * Every /api/helpdesk-news route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskNewsRoutes } from './index';

describeCrud('/api/helpdesk-news', {
  base: '/api/helpdesk-news',
  routes: helpdeskNewsRoutes,
  table: schema.helpdeskNews,
  gates: { read: 'articles:read', create: 'articles:create', update: 'articles:update', delete: 'articles:delete' },
  seed: (n) => ({ title: `News ${n}`, content: 'Body', authorId: 'user_a' }),
  valid: { title: 'Launch', content: 'We launched', authorId: 'user_a', tags: ['a', 'b'], isPinned: true },
  unstorable: { title: 'No content' },
  invalid: [{}, { title: '' }, { title: 'x', tags: [1] }, { title: 'x', authorId: 5 }],
  patch: { title: 'Renamed', excerpt: 'short' },
  invalidPatch: { title: 'x'.repeat(501) },
  filters: [{ query: 'search=Needle', match: { title: 'The Needle story' } }],
});
