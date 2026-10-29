/**
 * Every /api/helpdesk-faqs route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskFaqsRoutes } from './index';

describeCrud('/api/helpdesk-faqs', {
  base: '/api/helpdesk-faqs',
  routes: helpdeskFaqsRoutes,
  table: schema.helpdeskFaqs,
  gates: { read: 'articles:read', create: 'articles:create', update: 'articles:update', delete: 'articles:delete' },
  seed: (n) => ({ question: `Question ${n}`, answer: 'An answer', category: n % 2 ? 'billing' : 'general' }),
  valid: { question: 'How do I pay?', answer: 'With a card.', category: 'billing', isPublished: true, viewCount: 3 },
  invalid: [
    { answer: 'no question' },
    { question: '', answer: 'x' },
    { question: 'q', answer: 'a', sortOrder: 1.5 },
    { question: 'q', answer: 'a', category: 'x'.repeat(101) },
  ],
  patch: { answer: 'Updated', category: 'general', order: 4 },
  invalidPatch: { question: '' },
  filters: [{ query: 'category=special', match: { category: 'special' } }],
});

it('exports the router the suite mounts', () => {
  expect(helpdeskFaqsRoutes.routes.length).toBeGreaterThan(0);
});
