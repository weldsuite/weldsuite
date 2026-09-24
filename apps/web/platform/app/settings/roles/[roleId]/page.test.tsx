import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RoleDetailPage from './page';

vi.mock('@weldsuite/i18n/client', () => ({
  // `path(var1,var2)` so labels stay distinguishable per object/action.
  useTranslations: () => (path: string, vars?: Record<string, unknown>) =>
    vars ? `${path}(${Object.values(vars).join(',')})` : path,
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ roleId: 'role_sales' }),
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: 'idle' }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: () => true, isOwner: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/components/page-loader', () => ({ PageLoader: () => null }));

let rolePermissions: string[] = [];
let roleApps: string[] = [];
const put = vi.fn(async (_url: string, _body: unknown) => ({ data: {} }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({
      get: async (url: string) => {
        if (url === '/roles/installable-apps') {
          return {
            data: [
              { appCode: 'weldcrm', appName: 'WeldCRM' },
              { appCode: 'welddesk', appName: 'WeldDesk' },
              { appCode: 'weldagent', appName: 'WeldAgent' },
            ],
          };
        }
        return {
          data: {
            id: 'role_sales',
            name: 'Sales',
            description: '',
            isSystemRole: false,
            canDelete: true,
            canModify: true,
            memberCount: 2,
            permissions: rolePermissions,
            apps: roleApps,
            createdAt: '2026-01-01',
          },
        };
      },
      put,
    }),
  }),
}));

const VIEW = 'sweep.settings.roleDetail.actions.view';

async function renderPage(permissions: string[], apps: string[] = ['weldcrm']) {
  rolePermissions = permissions;
  roleApps = apps;
  render(<RoleDetailPage />);
  await screen.findByRole('heading', { name: 'Sales' });
}

function openSection(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function cell(action: string, object: string) {
  return screen.getByRole('checkbox', {
    name: `sweep.settings.roleDetail.actionObjectLabel(${action},${object})`,
  });
}

function isChecked(el: HTMLElement) {
  return el.getAttribute('data-state') === 'checked';
}

async function save() {
  fireEvent.click(screen.getAllByRole('button', { name: 'sweep.settings.roleDetail.saveChanges' })[0]!);
  await waitFor(() => expect(put).toHaveBeenCalled());
  return put.mock.calls[0]![1] as { permissions: string[]; apps: string[] };
}

describe('RoleDetailPage — per-app permissions', () => {
  beforeEach(() => put.mockClear());

  it('lists the workspace and each installed app; apps without a matrix get an access switch', async () => {
    await renderPage(['team:read']);
    expect(screen.getByRole('button', { name: /sweep.settings.appPermissions.workspace/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /WeldCRM/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /WeldDesk/ })).toBeTruthy();
    expect(screen.getByText('sweep.settings.appPermissions.otherApps')).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'sweep.settings.roleDetail.grantAppLabel(WeldAgent)' }),
    ).toBeTruthy();
    expect(isChecked(cell(VIEW, 'Team Members'))).toBe(true);
  });

  it('shows a legacy grant in every app and saves a per-app change app-qualified', async () => {
    await renderPage(['companies:read', 'team:read']);

    openSection(/WeldDesk/);
    const deskCompanies = cell(VIEW, 'Companies');
    expect(isChecked(deskCompanies)).toBe(true);
    fireEvent.click(deskCompanies);
    expect(isChecked(cell(VIEW, 'Companies'))).toBe(false);

    openSection(/WeldCRM/);
    expect(isChecked(cell(VIEW, 'Companies'))).toBe(true);

    const body = await save();
    expect(body.permissions).toContain('weldcrm:companies:read');
    expect(body.permissions).toContain('team:read');
    expect(body.permissions).not.toContain('welddesk:companies:read');
    expect(body.permissions).not.toContain('companies:read');
    expect(body.apps).toEqual(['weldcrm']);
  });

  it('grants opening an app from its section', async () => {
    await renderPage([]);
    openSection(/WeldDesk/);
    const label = screen.getByText('sweep.settings.appPermissions.canOpenApp(WeldDesk)').closest('label')!;
    fireEvent.click(label.querySelector('[role="checkbox"]')!);
    const body = await save();
    expect(body.apps).toEqual(expect.arrayContaining(['weldcrm', 'welddesk']));
  });

  it('applies Grant all, Read only and Revoke all to the selected app only', async () => {
    await renderPage(['weldcrm:companies:update']);
    openSection(/WeldDesk/);

    fireEvent.click(screen.getAllByRole('button', { name: 'sweep.settings.roleDetail.grantAll' })[0]!);
    expect(isChecked(cell('sweep.settings.roleDetail.actions.delete', 'Tickets'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'sweep.settings.appPermissions.readOnly' }));
    expect(isChecked(cell(VIEW, 'Tickets'))).toBe(true);
    expect(isChecked(cell('sweep.settings.roleDetail.actions.delete', 'Tickets'))).toBe(false);

    const body = await save();
    expect(body.permissions).toContain('welddesk:tickets:read');
    expect(body.permissions).not.toContain('welddesk:tickets:delete');
    expect(body.permissions).toContain('weldcrm:companies:update');

    fireEvent.click(screen.getAllByRole('button', { name: 'sweep.settings.roleDetail.revokeAll' })[0]!);
    expect(isChecked(cell(VIEW, 'Tickets'))).toBe(false);
  });

  it('toggles every action of one object from its row', async () => {
    await renderPage([]);
    openSection(/WeldDesk/);
    const rowGrant = screen.getAllByRole('button', { name: 'sweep.settings.roleDetail.grantAll' })[1]!;
    fireEvent.click(rowGrant);
    const checked = screen.getAllByRole('checkbox').filter(isChecked);
    expect(checked.length).toBeGreaterThan(0);
  });

  it('splits a wildcard into individual grants when a covered cell is unticked', async () => {
    await renderPage(['weldcrm:*']);
    openSection(/WeldCRM/);
    const crmCompanies = cell(VIEW, 'Companies');
    expect(isChecked(crmCompanies)).toBe(true);
    expect(crmCompanies.getAttribute('title')).toBe('sweep.settings.appPermissions.grantedByPattern(weldcrm:*)');

    fireEvent.click(crmCompanies);
    expect(isChecked(cell(VIEW, 'Companies'))).toBe(false);
    expect(isChecked(cell(VIEW, 'Leads'))).toBe(true);

    const body = await save();
    expect(body.permissions).not.toContain('weldcrm:*');
    expect(body.permissions).not.toContain('weldcrm:companies:read');
    expect(body.permissions).toContain('weldcrm:companies:update');
    expect(body.permissions).toContain('weldcrm:leads:read');
  });

  it('limits Revoke all to the objects the search shows', async () => {
    await renderPage(['welddesk:tickets:read', 'welddesk:companies:read']);
    fireEvent.change(screen.getByPlaceholderText('sweep.settings.roleDetail.searchPermissionsPlaceholder'), {
      target: { value: 'tickets' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'sweep.settings.roleDetail.revokeAll' })[0]!);

    const body = await save();
    expect(body.permissions).not.toContain('welddesk:tickets:read');
    expect(body.permissions).toContain('welddesk:companies:read');
  });

  it('filters apps and objects by search', async () => {
    await renderPage([]);
    fireEvent.change(screen.getByPlaceholderText('sweep.settings.roleDetail.searchPermissionsPlaceholder'), {
      target: { value: 'tickets' },
    });
    expect(screen.queryByRole('button', { name: /sweep.settings.appPermissions.workspace/ })).toBeNull();
    expect(screen.getByRole('button', { name: /WeldDesk/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /WeldCRM/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('sweep.settings.roleDetail.searchPermissionsPlaceholder'), {
      target: { value: 'zzz-nothing' },
    });
    expect(screen.getByText('sweep.settings.roleDetail.noPermissionsMatch(zzz-nothing)')).toBeTruthy();
  });

  it('toggles an app without a matrix from the other-apps list', async () => {
    await renderPage([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'sweep.settings.roleDetail.grantAppLabel(WeldAgent)' }));
    const body = await save();
    expect(body.apps).toEqual(expect.arrayContaining(['weldcrm', 'weldagent']));
  });
});
