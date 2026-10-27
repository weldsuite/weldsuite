import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SettingsLayoutClient } from './settings-layout-client';

vi.mock('@/lib/router', () => ({ usePathname: () => '/settings/team' }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: { settings: { title: 'Settings', menu: {} } } }),
}));
vi.mock('./breadcrumbs', () => ({ buildBreadcrumbSegments: () => [] }));
vi.mock('@/components/breadcrumb-header', () => ({ BreadcrumbHeader: () => null }));
// The real ModuleContent also mounts the object-panel and drawer hosts; only
// the `aside` slot matters here.
vi.mock('@/components/layout/module-content', () => ({
  ModuleContent: ({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) => (
    <div>
      {children}
      <div data-testid="aside">{aside}</div>
    </div>
  ),
}));

function announce(isOpen: boolean, width: number) {
  window.dispatchEvent(new CustomEvent('member-detail-panel', { detail: { isOpen, width } }));
}

function spacer(): HTMLElement | null {
  return screen.getByTestId('aside').firstElementChild as HTMLElement | null;
}

describe('SettingsLayoutClient member drawer reservation', () => {
  it('makes room for the member drawer while it is open', () => {
    render(<SettingsLayoutClient>page</SettingsLayoutClient>);
    expect(spacer()).toBeNull();

    act(() => announce(true, 480));
    expect(spacer()?.style.width).toBe('480px');

    act(() => announce(false, 0));
    expect(spacer()).toBeNull();
  });

  it('catches a drawer that opens in the same commit as the layout', () => {
    function OpenDrawer() {
      React.useEffect(() => announce(true, 480), []);
      return null;
    }
    render(
      <SettingsLayoutClient>
        <OpenDrawer />
      </SettingsLayoutClient>,
    );
    expect(spacer()?.style.width).toBe('480px');
  });
});
