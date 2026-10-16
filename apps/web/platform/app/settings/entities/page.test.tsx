import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import EntitiesSettingsPage from './page';

let tab: string | undefined;
let installed: string[] = [];
let permissions: string[] = [];
let payrollFlag = true;
const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({ tab }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.includes(permission), isOwner: false, isLoading: false }),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('@/hooks/use-installed-apps', () => ({
  useInstalledApps: () => ({ data: installed.map((appCode) => ({ appCode, status: 'active' })), isLoading: false }),
}));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollFlag: () => ({ enabled: payrollFlag, isLoading: false }),
}));

vi.mock('./components/accounting-entities-tab', () => ({
  AccountingEntitiesTab: () => <div>accounting panel</div>,
}));
vi.mock('@/app/weldhr/payroll/components/employers-section', () => ({
  PayrollEmployersSection: () => <div>employers panel</div>,
}));

describe('Settings → Entities page', () => {
  beforeEach(() => {
    tab = undefined;
    installed = ['weldbooks', 'weldhr'];
    permissions = ['entities:read', 'payroll:manage'];
    payrollFlag = true;
    navigate.mockClear();
  });

  it('shows both tabs and opens the WeldBooks entities first', () => {
    render(<EntitiesSettingsPage />);

    expect(screen.getByRole('heading', { name: en.settings.entities.title })).toBeTruthy();
    expect(screen.getByRole('tab', { name: en.settings.entities.tabs.accounting })).toBeTruthy();
    expect(screen.getByRole('tab', { name: en.settings.entities.tabs.employers })).toBeTruthy();
    expect(screen.getByText('accounting panel')).toBeTruthy();
    expect(screen.queryByText('employers panel')).toBeNull();
  });

  it('opens the payroll employers from the query string', () => {
    tab = 'employers';
    render(<EntitiesSettingsPage />);

    expect(screen.getByText('employers panel')).toBeTruthy();
    expect(screen.queryByText('accounting panel')).toBeNull();
  });

  it('writes the selected tab into the URL', () => {
    render(<EntitiesSettingsPage />);

    fireEvent.click(screen.getByRole('tab', { name: en.settings.entities.tabs.employers }));

    expect(navigate).toHaveBeenCalledWith({ to: '/settings/entities', search: { tab: 'employers' } });
  });

  it('shows only the employers without WeldBooks, and no tab bar for one tab', () => {
    installed = ['weldhr'];
    render(<EntitiesSettingsPage />);

    expect(screen.getByText('employers panel')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('leaves the employers out while payroll is off or without payroll:manage', () => {
    payrollFlag = false;
    const { unmount } = render(<EntitiesSettingsPage />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('accounting panel')).toBeTruthy();
    unmount();

    payrollFlag = true;
    permissions = ['entities:read'];
    render(<EntitiesSettingsPage />);
    expect(screen.queryByText('employers panel')).toBeNull();
  });

  it('says so when the member may see no entities', () => {
    permissions = [];
    render(<EntitiesSettingsPage />);

    expect(screen.getByText(en.settings.entities.noAccess)).toBeTruthy();
  });
});
