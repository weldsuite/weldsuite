import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemberAppPermissions } from './member-app-permissions';

vi.mock('@weldsuite/i18n/client', () => ({
  // `path(var1,var2)` so labels stay distinguishable per object/action.
  useTranslations: () => (path: string, vars?: Record<string, unknown>) =>
    vars ? `${path}(${Object.values(vars).join(',')})` : path,
}));

const VIEW_COMPANIES = 'actions.view,Companies)';

function renderPanel(props: Partial<Parameters<typeof MemberAppPermissions>[0]> = {}) {
  const onSave = vi.fn(async () => true);
  render(
    <MemberAppPermissions
      inheritedPermissions={['companies:read']}
      memberOverrides={[]}
      memberDenies={[]}
      installedAppCodes={['weldcrm', 'welddesk']}
      roleLabel="Member"
      canManage
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

function viewCompaniesToggle() {
  return screen.getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes(VIEW_COMPANIES));
}

describe('MemberAppPermissions', () => {
  it('shows one section per installed app plus the workspace', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /WeldCRM/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /WeldDesk/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /WeldBooks/ })).toBeNull();
  });

  it('denies an inherited permission in one app only', async () => {
    const { onSave } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /WeldDesk/ }));
    const toggle = viewCompaniesToggle();
    expect(toggle?.getAttribute('aria-label')).toContain('inheritedFrom(Member)');
    fireEvent.click(toggle!);
    expect(viewCompaniesToggle()?.getAttribute('aria-label')).toContain('appPermissions.denied');

    // Still inherited in WeldCRM.
    fireEvent.click(screen.getByRole('button', { name: /WeldCRM/ }));
    expect(viewCompaniesToggle()?.getAttribute('aria-label')).toContain('inheritedFrom(Member)');

    fireEvent.click(screen.getByRole('button', { name: 'sweep.settings.appPermissions.save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([], ['welddesk:companies:read']));
  });

  it('allows a permission the role does not give, and clicking again reverts it', () => {
    renderPanel({ inheritedPermissions: [] });
    fireEvent.click(screen.getByRole('button', { name: /WeldCRM/ }));
    fireEvent.click(viewCompaniesToggle()!);
    expect(viewCompaniesToggle()?.getAttribute('aria-label')).toContain('appPermissions.allowed');
    fireEvent.click(viewCompaniesToggle()!);
    expect(viewCompaniesToggle()?.getAttribute('aria-label')).toContain('inheritedFrom(Member)');
    expect(screen.queryByRole('button', { name: 'sweep.settings.appPermissions.save' })).toBeNull();
  });

  it('shows stored legacy overrides per app and is read-only without manage rights', () => {
    renderPanel({ inheritedPermissions: [], memberDenies: ['companies:read'], canManage: false });
    fireEvent.click(screen.getByRole('button', { name: /WeldDesk/ }));
    const toggle = viewCompaniesToggle()!;
    expect(toggle.getAttribute('aria-label')).toContain('appPermissions.denied');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});
