import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AppAccessGuard } from './app-access-guard';
import { setRuntimeConfig } from '@/lib/runtime-config';

let pathname = '/';
let memberType: 'INTERNAL' | 'EXTERNAL_GUEST' | 'EMPLOYEE' = 'EMPLOYEE';
let installed = ['weldhr', 'weldchat', 'weldcrm'];
let installedObjects: string[] = [];
let canManageApps = true;
const replace = vi.fn();
const push = vi.fn();
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('@/lib/router', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, push }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
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

vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useCanManageApps: () => ({ data: canManageApps }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ isLoading: false, isOwner: true, hasAnyObject: () => true }),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: { common: { edition: { unavailableTitle: 'Not available in this edition', unavailableDescription: '', backHome: 'Home' } } },
  }),
}));

vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderAt(path: string) {
  pathname = path;
  render(
    <AppAccessGuard>
      <div />
    </AppAccessGuard>,
  );
}

function renderPage(path: string) {
  pathname = path;
  return render(
    <AppAccessGuard>
      <div data-testid="page" />
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
    canManageApps = true;
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

  it('tells a member who cannot manage apps it is unavailable, without the App Store link', () => {
    // Their list only holds the apps their role grants, so the app may well be installed.
    canManageApps = false;
    renderAt('/weldcall');
    expect(replace).toHaveBeenLastCalledWith('/');
    const [message, options] = toastInfo.mock.calls[0] as [string, { action?: unknown }];
    expect(message).toContain('common.empty.appUnavailableNamed');
    expect(message).toContain('WeldCall');
    expect(options.action).toBeUndefined();
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

describe('AppAccessGuard · edition flags', () => {
  beforeEach(() => {
    memberType = 'INTERNAL';
    installed = ['weldcrm', 'weldknow'];
    installedObjects = [];
    replace.mockClear();
    toastInfo.mockClear();
    setRuntimeConfig({
      backend: 'rust',
      modules: ['core', 'know', 'sign', 'pass', 'calendar'],
      unavailableFeatures: ['billing', 'sso-connections'],
    });
  });

  afterEach(() => setRuntimeConfig(null));

  it('says a page of a module the deployment does not serve is unavailable, without redirecting', () => {
    const { getByText } = renderPage('/weldcrm/companies');
    expect(getByText('Not available in this edition')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('does the same for WeldAgent and for features the backend lacks', () => {
    for (const path of ['/agents', '/new-chat', '/settings/billing', '/settings/sso']) {
      const { getByText, unmount } = renderPage(path);
      expect(getByText('Not available in this edition'), path).toBeTruthy();
      unmount();
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it('renders the pages it does serve', () => {
    const { getByTestId } = renderPage('/weldknow');
    expect(getByTestId('page')).toBeTruthy();
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
