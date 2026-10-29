/**
 * Every /api/helpdesk-announcements route on pglite, through the shared CRUD
 * suite (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskAnnouncementsRoutes } from './index';

describeCrud('/api/helpdesk-announcements', {
  base: '/api/helpdesk-announcements',
  routes: helpdeskAnnouncementsRoutes,
  table: schema.helpdeskAnnouncements,
  gates: { read: 'articles:read', create: 'articles:create', update: 'articles:update', delete: 'articles:delete' },
  seed: (n) => ({ title: `Announcement ${n}`, content: 'Body', authorId: 'user_a' }),
  valid: { title: 'Maintenance', content: 'Tonight', authorId: 'user_a', audience: 'all' },
  unstorable: { title: 'No content', body: 'body is not a column' },
  invalid: [{ title: '' }, { title: 'x', audience: 'x'.repeat(51) }, { title: 'x', isPublished: 'yes' }],
  patch: { title: 'Maintenance moved', status: 'published' },
  invalidPatch: { title: 7 },
  filters: [{ query: 'search=Needle', match: { title: 'Needle notice' } }],
});
