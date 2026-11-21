import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import { WeldPanelProjectSwitcher } from './project-switcher';

const state = vi.hoisted(() => ({
  analytics: true,
  canCreate: true,
  projects: [] as unknown[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => state.analytics }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: state.projects, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('./create-project-dialog', () => ({
  CreateProjectDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="New project" /> : null),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

function renderSwitcher() {
  return render(
    <SidebarProvider>
      <WeldPanelProjectSwitcher />
    </SidebarProvider>,
  );
}

describe('WeldPanelProjectSwitcher', () => {
  beforeEach(() => {
    state.analytics = true;
    state.canCreate = true;
    state.projects = [
      makeProject({ id: 'wpp_1', name: 'Marketing site' }),
      makeProject({ id: 'wpp_2', name: 'Docs', kind: 'app', status: 'paused' }),
    ];
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('shows the project in use with what it tracks and whether it collects', () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /Marketing site/ });
    expect(trigger.textContent).toContain('Website · Active');
  });

  it('switches project from the menu and remembers the choice', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: /Marketing site/ }));
    expect(screen.getByText('Web app · Paused')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: /Docs/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Docs/ })).toBeTruthy());
    expect(window.localStorage.getItem('weldpanel:last-project:ws_1')).toBe('wpp_2');
  });

  it('opens the create dialog from New project', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: /Marketing site/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('has no New project item without panel_projects:create', async () => {
    state.canCreate = false;
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: /Marketing site/ }));
    expect(screen.queryByRole('menuitem', { name: 'New project' })).toBeNull();
  });

  it('is not there without a project, or where analytics are off (Kubernetes)', () => {
    state.projects = [];
    const { unmount } = renderSwitcher();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    state.projects = [makeProject()];
    state.analytics = false;
    renderSwitcher();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
