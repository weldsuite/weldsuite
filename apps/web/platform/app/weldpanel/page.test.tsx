import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { makeInstall, makeProject } from './test-fixtures';
import WeldPanelHome from './page';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  canCreate: true,
  projects: [] as unknown[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  installFor: [] as string[],
  create: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: state.isError ? undefined : state.projects, isLoading: state.isLoading, isError: state.isError, refetch: state.refetch }),
  useWeldPanelInstall: (projectId: string) => {
    state.installFor.push(projectId);
    return { data: makeInstall({ projectId }), isLoading: false, isError: false, refetch: vi.fn() };
  },
  useCreateWeldPanelProject: () => ({ mutateAsync: state.create, isPending: false }),
}));

const th = en.weldpanel.home;

describe('WeldPanel home', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.canCreate = true;
    state.projects = [];
    state.isLoading = false;
    state.isError = false;
    state.refetch.mockReset();
    state.installFor = [];
    state.create.mockReset();
    state.push.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => window.localStorage.clear());

  describe('without projects', () => {
    it('shows the empty state and the three steps', () => {
      render(<WeldPanelHome />);
      expect(screen.getByText(th.emptyTitle)).toBeTruthy();
      for (const step of Object.values(th.steps)) expect(screen.getByText(step.title)).toBeTruthy();
    });

    it('has an enabled New project button that opens the create dialog', async () => {
      render(<WeldPanelHome />);
      const button = screen.getByRole('button', { name: th.newProject }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      await userEvent.click(button);
      expect(await screen.findByRole('dialog', { name: en.weldpanel.createDialog.title })).toBeTruthy();
    });

    it('validates the name in the dialog before creating', async () => {
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: th.newProject }));
      await userEvent.click(await screen.findByRole('button', { name: en.weldpanel.createDialog.submit }));
      expect(await screen.findByText(en.weldpanel.validation.nameRequired)).toBeTruthy();
      expect(state.create).not.toHaveBeenCalled();
    });

    it('creates a project and goes to its install tab', async () => {
      state.create.mockResolvedValue(makeProject({ id: 'wpp_new' }));
      render(<WeldPanelHome />);
      await userEvent.click(screen.getByRole('button', { name: th.newProject }));
      await userEvent.type(await screen.findByLabelText(en.weldpanel.general.nameLabel), 'Docs');
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.createDialog.submit }));
      await waitFor(() => expect(state.push).toHaveBeenCalledWith('/weldpanel/projects/wpp_new'));
    });

    it('hides the button without panel_projects:create and points to an admin', () => {
      state.canCreate = false;
      render(<WeldPanelHome />);
      expect(screen.queryByRole('button', { name: th.newProject })).toBeNull();
      expect(screen.getByText(th.emptyNoCreate)).toBeTruthy();
    });
  });

  describe('with projects', () => {
    const projects: PanelProjectDto[] = [
      makeProject({ id: 'wpp_1', name: 'Marketing site' }),
      makeProject({ id: 'wpp_2', name: 'Web app', kind: 'app' }),
    ];

    it('shows the first project and its install status', () => {
      state.projects = projects;
      render(<WeldPanelHome />);
      expect(screen.getByRole('combobox', { name: th.projectLabel }).textContent).toContain('Marketing site');
      expect(screen.getByText(en.weldpanel.install.statusTitle)).toBeTruthy();
      expect(new Set(state.installFor)).toEqual(new Set(['wpp_1']));
      expect(screen.queryByText(th.emptyTitle)).toBeNull();
    });

    it('opens the project last used in this workspace', () => {
      window.localStorage.setItem('weldpanel:last-project:ws_1', 'wpp_2');
      state.projects = projects;
      render(<WeldPanelHome />);
      expect(screen.getByRole('combobox', { name: th.projectLabel }).textContent).toContain('Web app');
      expect(new Set(state.installFor)).toEqual(new Set(['wpp_2']));
    });

    it('ignores a remembered project that is gone', () => {
      window.localStorage.setItem('weldpanel:last-project:ws_1', 'wpp_deleted');
      state.projects = projects;
      render(<WeldPanelHome />);
      expect(new Set(state.installFor)).toEqual(new Set(['wpp_1']));
    });

    it('says reports are not here yet, and keeps New project in the header', () => {
      state.projects = projects;
      render(<WeldPanelHome />);
      expect(screen.getByText(th.reportsTitle)).toBeTruthy();
      expect(screen.getByText(th.reportsDescription)).toBeTruthy();
      expect(screen.getByRole('button', { name: th.newProject })).toBeTruthy();
    });

    it('links to the projects list and the install instructions', () => {
      state.projects = projects;
      render(<WeldPanelHome />);
      expect(screen.getByRole('link', { name: th.allProjects }).getAttribute('href')).toBe('/weldpanel/projects');
      expect(screen.getByRole('link', { name: en.weldpanel.install.openProject }).getAttribute('href')).toBe('/weldpanel/projects/wpp_1');
    });
  });

  it('offers a retry when the projects cannot be loaded', async () => {
    state.isError = true;
    render(<WeldPanelHome />);
    expect(screen.getByText(th.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a loader while the projects load', () => {
    state.isLoading = true;
    render(<WeldPanelHome />);
    expect(screen.getByText(en.common.labels.loading)).toBeTruthy();
    expect(screen.queryByText(th.emptyTitle)).toBeNull();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    render(<WeldPanelHome />);
    expect(screen.getByRole('heading', { name: nl.weldpanel.home.title })).toBeTruthy();
    expect(screen.getByText(nl.weldpanel.home.emptyTitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: nl.weldpanel.home.newProject })).toBeTruthy();
  });
});
