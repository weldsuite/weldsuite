import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { isProjectsPath } from './layout';
import { resetCurrentProjectChoice } from './lib/use-current-project';
import { makeProject } from './test-fixtures';
import WeldPanelLayout from './layout';

const state = vi.hoisted(() => ({
  pathname: '/weldpanel',
  analytics: true,
  installed: true,
  canRead: true,
  projects: [] as unknown[],
  replace: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canRead }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.installed, isLoading: false }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => state.analytics }));
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => <header data-testid="app-header" /> }));
vi.mock('@/components/layout/module-content', () => ({ ModuleContent: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/contexts/breadcrumb-context', () => ({ BreadcrumbProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/router', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: state.replace }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: state.projects, isLoading: false, isError: false, refetch: vi.fn() }),
  // The usage banner reads it; no usage means no banner.
  useWeldPanelUsage: () => ({ data: undefined }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

describe('isProjectsPath', () => {
  it('matches the projects list and the pages under it only', () => {
    expect(isProjectsPath('/weldpanel/projects')).toBe(true);
    expect(isProjectsPath('/weldpanel/projects/wpp_1')).toBe(true);
    expect(isProjectsPath('/weldpanel')).toBe(false);
    expect(isProjectsPath('/weldpanel/projectsx')).toBe(false);
  });
});

describe('WeldPanel layout', () => {
  beforeEach(() => {
    state.pathname = '/weldpanel';
    state.analytics = true;
    state.installed = true;
    state.canRead = true;
    state.projects = [makeProject({ id: 'wpp_1', name: 'Marketing site' }), makeProject({ id: 'wpp_2', name: 'Docs' })];
    state.replace.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('puts the project switcher under the header of an analytics page', () => {
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.getByTestId('weldpanel-project-bar')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Project' }).textContent).toContain('Marketing site');
    expect(screen.getByText('page')).toBeTruthy();
  });

  it('remembers the project chosen in the switcher', async () => {
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Docs' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Project' }).textContent).toContain('Docs'));
    expect(window.localStorage.getItem('weldpanel:last-project:ws_1')).toBe('wpp_2');
  });

  it('leaves the switcher off the Projects pages, which pick the project themselves', () => {
    state.pathname = '/weldpanel/projects/wpp_1';
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.queryByTestId('weldpanel-project-bar')).toBeNull();
  });

  it('has no switcher without a project', () => {
    state.projects = [];
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.queryByTestId('weldpanel-project-bar')).toBeNull();
  });

  it('redirects every page but the projects to the projects where analytics are off (Kubernetes)', async () => {
    state.analytics = false;
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.queryByText('page')).toBeNull();
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/weldpanel/projects'));
  });

  it('serves the projects pages there, without a switcher', () => {
    state.analytics = false;
    state.pathname = '/weldpanel/projects';
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.getByText('page')).toBeTruthy();
    expect(screen.queryByTestId('weldpanel-project-bar')).toBeNull();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('says so when the app is not installed or the permission is missing', () => {
    state.installed = false;
    const { unmount } = render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.queryByText('page')).toBeNull();
    unmount();
    state.installed = true;
    state.canRead = false;
    render(
      <WeldPanelLayout>
        <p>page</p>
      </WeldPanelLayout>,
    );
    expect(screen.getByText("You don't have access to WeldPanel.")).toBeTruthy();
  });
});
