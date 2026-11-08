/**
 * Every /api/slas route on pglite, through the shared CRUD suite
 * (../../test/crud-suite.ts); runs against Rust in conformance mode.
 */

import { expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { slasRoutes } from './index';

const target = { priority: 'medium', time: 90, notifyAt: [50, 90] };

describeCrud('/api/slas', {
  base: '/api/slas',
  routes: slasRoutes,
  table: schema.helpdeskSlas,
  gates: { read: 'slas:read', create: 'slas:create', update: 'slas:update', delete: 'slas:delete' },
  seed: (n) => ({ name: `SLA ${n}` }),
  valid: {
    name: 'Gold',
    description: 'Fast',
    isActive: true,
    isDefault: false,
    priority: 2,
    conditions: [
      { field: 'priority', operator: 'greater_than', value: 'medium' },
      { field: 'tags', operator: 'contains', value: 'vip' },
    ],
    firstResponseTime: [target, { priority: 'urgent', time: 15 }],
    updateTime: [{ priority: 'medium', time: 240 }],
    resolutionTime: [{ priority: 'critical', time: 480 }],
    reminders: [{ type: 'before_breach', time: 30, recipients: ['assignee', 'manager'] }],
    operationalHours: 'custom',
    businessHours: {
      timezone: 'Europe/Amsterdam',
      monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
      saturday: { isOpen: false },
      holidays: [{ date: '2026-12-25', name: 'Christmas', isRecurring: true }],
    },
  },
  invalid: [
    { name: '' },
    { name: 'x'.repeat(256) },
    // `priority` is the order policies are checked in: an integer, not a ticket priority.
    { name: 'x', priority: 'high' },
    { name: 'x', priority: 1.5 },
    { name: 'x', priority: -1 },
    { name: 'x', description: 5 },
    { name: 'x', operationalHours: 'weekdays' },
    { name: 'x', conditions: [{ field: '', operator: 'equals', value: 'a' }] },
    { name: 'x', conditions: [{ field: 'priority', operator: 'is', value: 'a' }] },
    { name: 'x', conditions: 'priority' },
    { name: 'x', firstResponseTime: [{ priority: 'medium', time: 0 }] },
    { name: 'x', firstResponseTime: [{ priority: 'medium', time: 1.5 }] },
    { name: 'x', updateTime: [{ priority: 'someday', time: 10 }] },
    { name: 'x', resolutionTime: [{ priority: 'low', time: 10, notifyAt: [150] }] },
    { name: 'x', reminders: [{ type: 'during_breach', time: 10 }] },
    { name: 'x', reminders: [{ type: 'before_breach', time: 10, recipients: ['everyone'] }] },
    { name: 'x', businessHours: { monday: { isOpen: true } } },
    { name: 'x', businessHours: { timezone: 'UTC', monday: { openTime: '09:00' } } },
    { name: 'x', businessHours: { timezone: 'UTC', holidays: [{ date: '2026-12-25' }] } },
  ],
  patch: { name: 'Platinum', operationalHours: 'business', businessHours: null, conditions: null },
  invalidPatch: { isActive: 'yes' },
  filters: [{ query: 'search=Needle', match: { name: 'Needle SLA' } }],
});

it('exports the router the suite mounts', () => {
  expect(slasRoutes.routes.length).toBeGreaterThan(0);
});
