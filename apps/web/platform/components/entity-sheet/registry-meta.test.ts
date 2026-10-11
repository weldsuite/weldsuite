import { describe, expect, it } from 'vitest';
import { pageHrefForEntity } from './registry-meta';

describe('pageHrefForEntity', () => {
  it.each([
    ['article', '/welddesk/help-center/articles/x_1'],
    ['invoice', '/weldbooks/invoices/x_1'],
    ['bill', '/weldbooks/bills/x_1'],
    ['project', '/weldflow/project/x_1'],
    ['task', '/weldflow/task/x_1'],
    ['domain', '/weldhost/domains/x_1'],
  ] as const)('links a %s to its page', (type, href) => {
    expect(pageHrefForEntity(type, 'x_1')).toBe(href);
  });

  // `/welddesk/tickets/:id` and `/weldcrm/{leads,opportunities}/:id` don't
  // exist; these only open in the sheet.
  it.each(['ticket', 'lead', 'opportunity'] as const)('has no page for a %s', (type) => {
    expect(pageHrefForEntity(type, 'x_1')).toBeNull();
  });
});
