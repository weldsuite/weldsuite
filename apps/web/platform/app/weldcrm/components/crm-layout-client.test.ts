import { describe, expect, it } from 'vitest';
import { getCrmBreadcrumbs, getCrmSectionLabelKey } from './crm-layout-client';

const labels: Record<string, string> = {
  'crm.breadcrumb.crm': 'CRM',
  'crm.breadcrumb.deals': 'Deals',
  'crm.sidebar.lists': 'Lists',
  'navigation.moduleSidebar.weldcrm.myTasks': 'My Tasks',
  'navigation.moduleSidebar.weldcrm.companies': 'Companies',
  'navigation.moduleSidebar.weldcrm.people': 'People',
  'navigation.moduleSidebar.weldcrm.notes': 'Notes',
};
const t = (key: string) => labels[key] ?? key;

describe('getCrmBreadcrumbs', () => {
  it.each([
    ['/weldcrm', 'My Tasks'],
    ['/weldcrm/companies', 'Companies'],
    ['/weldcrm/people', 'People'],
    ['/weldcrm/notes', 'Notes'],
    ['/weldcrm/pipeline/pipe_1', 'Deals'],
    ['/weldcrm/lists/list_1', 'Lists'],
    ['/weldcrm/companies/lists/list_1', 'Lists'],
  ])('shows the section after CRM for %s', (path, section) => {
    expect(getCrmBreadcrumbs(path, t)).toEqual([
      { label: 'CRM', href: '/weldcrm' },
      { label: section },
    ]);
  });

  it('leaves Sequences to its own pages', () => {
    expect(getCrmSectionLabelKey('/weldcrm/sequences')).toBeNull();
    expect(getCrmSectionLabelKey('/weldcrm/sequences/seq_1/people')).toBeNull();
  });
});
