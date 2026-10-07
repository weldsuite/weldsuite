import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import WeldHrSettingsPage from './page';

let tab: string | undefined;
let canManage = true;
const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({ tab }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => canManage && permission === 'employees:manage' }),
}));

vi.mock('@/app/weldhr/settings/components/departments-tab', () => ({
  DepartmentsTab: () => <div>departments panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/templates-tab', () => ({
  TemplatesTab: () => <div>templates panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/leave-types-tab', () => ({
  LeaveTypesTab: () => <div>leave types panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/evaluation-forms-tab', () => ({
  EvaluationFormsTab: () => <div>evaluation forms panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/kpis-tab', () => ({
  KpisTab: () => <div>kpis panel</div>,
}));

describe('WeldHR settings page', () => {
  beforeEach(() => {
    tab = undefined;
    canManage = true;
    navigate.mockClear();
  });

  it('shows the settings title and the departments tab by default', () => {
    render(<WeldHrSettingsPage />);

    expect(screen.getByRole('heading', { name: en.settings.weldhr.title })).toBeTruthy();
    expect(screen.getByText(en.settings.weldhr.description)).toBeTruthy();
    expect(screen.getByText('departments panel')).toBeTruthy();
    expect(screen.queryByText('templates panel')).toBeNull();
  });

  it('opens the tab from the query string', () => {
    tab = 'templates';
    render(<WeldHrSettingsPage />);

    expect(screen.getByText('templates panel')).toBeTruthy();
    expect(screen.queryByText('departments panel')).toBeNull();
  });

  it('writes the selected tab into the settings URL', () => {
    render(<WeldHrSettingsPage />);

    fireEvent.click(screen.getByRole('tab', { name: en.weldhr.settings.tabs.leaveTypes }));

    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/apps/weldhr',
      search: { tab: 'leave-types' },
    });
  });

  it('hides the editors without employees:manage', () => {
    canManage = false;
    render(<WeldHrSettingsPage />);

    expect(screen.getByText(en.weldhr.common.noPermission)).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
