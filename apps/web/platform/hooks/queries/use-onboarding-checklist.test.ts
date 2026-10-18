import { describe, it, expect } from 'vitest';
import { checklistTasksFor } from './use-onboarding-checklist';

const keys = (appCode: string, seatLimit: number | null | undefined) =>
  checklistTasksFor(appCode, { seatLimit }).map((task) => task.key);

describe('checklistTasksFor', () => {
  it('includes the general workspace tasks next to the app tasks', () => {
    expect(keys('weldflow', 10)).toEqual(['workspace_member_invited', 'workspace_logo_uploaded', 'project_created']);
  });

  it('drops "invite a team member" on a plan limited to one seat', () => {
    expect(keys('weldflow', 1)).toEqual(['workspace_logo_uploaded', 'project_created']);
    expect(keys('weldflow', 1)).not.toContain('workspace_member_invited');
  });

  it('keeps it for unlimited plans and while the limit is unknown', () => {
    expect(keys('weldflow', null)).toContain('workspace_member_invited');
    expect(keys('weldflow', undefined)).toContain('workspace_member_invited');
  });

  it('shows only CRM tasks in CRM', () => {
    expect(keys('weldcrm', 10)).not.toContain('workspace_member_invited');
    expect(keys('weldcrm', 10)).toContain('crm_customer_created');
  });
});
