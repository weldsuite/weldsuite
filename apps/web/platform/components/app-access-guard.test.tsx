import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AppAccessGuard } from './app-access-guard';

let pathname = '/';
let memberType: 'INTERNAL' | 'EXTERNAL_GUEST' | 'EMPLOYEE' = 'EMPLOYEE';
let installed = ['weldhr', 'weldchat', 'weldcrm'];
const replace = vi.fn();

vi.mock('@/lib/router', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace }),
}));

vi.mock('@/hooks/use-installed-apps', () => ({
  useInstalledApps: () => ({ data: installed.map((appCode) => ({ appCode })), isLoading: false }),
}));

vi.mock('@/hooks/use-current-member', () => ({
  useIsGuest: () => memberType === 'EXTERNAL_GUEST',
  useIsEmployeeMember: () => memberType === 'EMPLOYEE',
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ isLoading: false, isOwner: true, hasAnyObject: () => true }),
}));

function renderAt(path: string) {
  pathname = path;
  render(
    <AppAccessGuard>
      <div />
    </AppAccessGuard>,
  );
}

describe('AppAccessGuard · EMPLOYEE members', () => {
  beforeEach(() => {
    memberType = 'EMPLOYEE';
    installed = ['weldhr', 'weldchat', 'weldcrm'];
    replace.mockClear();
  });

  it('sends them from other apps and the home page to My HR', () => {
    renderAt('/weldcrm/companies');
    expect(replace).toHaveBeenLastCalledWith('/weldhr/me');

    renderAt('/');
    expect(replace).toHaveBeenLastCalledWith('/weldhr/me');

    renderAt('/weldhr/employees');
    expect(replace).toHaveBeenLastCalledWith('/weldhr/me');
  });

  it('keeps them on My HR, reporting sick, WeldChat and their own settings', () => {
    for (const path of ['/weldhr/me', '/weldhr/absenteeism', '/weldchat', '/weldchat/c/general', '/settings', '/settings/notifications']) {
      renderAt(path);
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it('blocks workspace settings', () => {
    renderAt('/settings/team');
    expect(replace).toHaveBeenLastCalledWith('/weldhr/me');
  });

  it('falls back to WeldChat when WeldHR is not installed', () => {
    installed = ['weldchat'];
    renderAt('/weldcrm');
    expect(replace).toHaveBeenLastCalledWith('/weldchat');
  });

  it('leaves internal members alone', () => {
    memberType = 'INTERNAL';
    renderAt('/weldcrm/companies');
    expect(replace).not.toHaveBeenCalled();
  });
});
