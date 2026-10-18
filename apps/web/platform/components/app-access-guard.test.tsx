import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AppAccessGuard } from './app-access-guard';

let pathname = '/';
let memberType: 'INTERNAL' | 'EXTERNAL_GUEST' | 'EMPLOYEE' = 'EMPLOYEE';
let installed = ['weldhr', 'weldchat', 'weldcrm'];
let installedObjects: string[] = [];
const replace = vi.fn();
const push = vi.fn();
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('@/lib/router', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, push }),
}));

vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}));

vi.mock('@/hooks/use-installed-apps', () => ({
  getFirstPartyAppName: (code: string) => ({ weldcall: 'WeldCall', weldcrm: 'WeldCRM' })[code] ?? null,
  useInstalledApps: () => ({
    data: [
      ...installed.map((appCode) => ({ appCode })),
      ...installedObjects.map((appCode) => ({ appCode, appType: 'object' })),
    ],
    isLoading: false,
  }),
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

    // HR's sick-report lists; employees report sick under My HR → Time off.
    renderAt('/weldhr/absenteeism');
    expect(replace).toHaveBeenLastCalledWith('/weldhr/me');
  });

  it('keeps them on My HR, WeldChat and their own settings', () => {
    for (const path of ['/weldhr/me', '/weldhr/me/time-off', '/weldchat', '/weldchat/c/general', '/settings', '/settings/notifications']) {
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

describe('AppAccessGuard · apps that are not installed', () => {
  beforeEach(() => {
    memberType = 'INTERNAL';
    installed = ['weldcrm'];
    installedObjects = [];
    replace.mockClear();
    push.mockClear();
    toastInfo.mockClear();
  });

  it('sends home and says the app is not installed, with a link to the App Store', () => {
    renderAt('/weldcall');
    expect(replace).toHaveBeenLastCalledWith('/');
    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [message, options] = toastInfo.mock.calls[0] as [string, { action: { onClick: () => void } }];
    expect(message).toContain('common.empty.appNotInstalledNamed');
    expect(message).toContain('WeldCall');
    options.action.onClick();
    expect(push).toHaveBeenCalledWith('/appstore');
  });

  it('keeps the silent redirect for an unknown first segment', () => {
    renderAt('/not-an-app');
    expect(replace).toHaveBeenLastCalledWith('/');
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('says nothing for an installed app', () => {
    renderAt('/weldcrm/companies');
    expect(replace).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe('AppAccessGuard · custom objects', () => {
  beforeEach(() => {
    memberType = 'INTERNAL';
    installed = ['weldcrm'];
    installedObjects = ['machines'];
    replace.mockClear();
  });

  it('opens the list and records of an object in the installed list', () => {
    renderAt('/objects/machines');
    renderAt('/objects/machines/rec_123');
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends an object that is not in the list home', () => {
    renderAt('/objects/invoices');
    expect(replace).toHaveBeenLastCalledWith('/');
  });
});
