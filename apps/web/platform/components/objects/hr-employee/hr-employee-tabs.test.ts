import { describe, expect, it } from 'vitest';
import { hrEmployeePanelHref } from './hr-employee-tabs';

describe('hrEmployeePanelHref', () => {
  it('opens the employee list with the employee in fullscreen', () => {
    expect(hrEmployeePanelHref('hremp_1')).toBe('/weldhr/employees?stack=hr_employee:hremp_1:fullscreen');
  });

  it('keeps the tab an old link asked for', () => {
    expect(hrEmployeePanelHref('hremp_1', 'payroll')).toBe(
      '/weldhr/employees?stack=hr_employee:hremp_1:fullscreen:tab=payroll',
    );
  });

  it('drops a tab the panel does not have', () => {
    expect(hrEmployeePanelHref('hremp_1', 'coaching')).toBe('/weldhr/employees?stack=hr_employee:hremp_1:fullscreen');
    expect(hrEmployeePanelHref('hremp_1', 'toString')).toBe('/weldhr/employees?stack=hr_employee:hremp_1:fullscreen');
  });
});
