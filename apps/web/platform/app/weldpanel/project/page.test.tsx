import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { PanelInstallInfo, PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { makeInstall, makeProject } from '../test-fixtures';
import WeldPanelProjectPage from './page';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  perms: new Set<string>(),
  project: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  refetch: vi.fn(),
  install: undefined as unknown,
  update: vi.fn(),
  updateSettings: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ projectId: 'wpp_1' }) }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.perms.has(permission) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProject: () => ({ data: state.project, isLoading: state.isLoading, error: state.error, refetch: state.refetch }),
  useWeldPanelInstall: () => ({ data: state.install, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
  useUpdateWeldPanelProject: () => ({ mutateAsync: state.update, isPending: false }),
  useUpdateWeldPanelProjectSettings: () => ({ mutateAsync: state.updateSettings, isPending: false }),
  useRotateWeldPanelToken: () => ({ mutateAsync: state.rotate, isPending: false }),
  useDeleteWeldPanelProject: () => ({ mutateAsync: state.remove, isPending: false }),
}));

const tp = en.weldpanel.project;
const READ = 'panel_projects:read';

function show(project: PanelProjectDto = makeProject(), install: PanelInstallInfo = makeInstall({ token: project.token })) {
  state.project = project;
  state.install = install;
  return { user: userEvent.setup(), ...render(<WeldPanelProjectPage />) };
}

describe('WeldPanel project page', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.perms = new Set([READ]);
    state.project = undefined;
    state.isLoading = false;
    state.error = null;
    state.install = undefined;
    for (const fn of [state.refetch, state.update, state.updateSettings, state.rotate, state.remove, state.push, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
  });

  describe('header', () => {
    it('shows the name, type, status and creation date', () => {
      show();
      expect(screen.getByRole('heading', { name: 'Marketing site' })).toBeTruthy();
      expect(screen.getByText(en.weldpanel.kinds.website)).toBeTruthy();
      expect(screen.getByText(en.weldpanel.statuses.active)).toBeTruthy();
      expect(screen.getByText(/^Created /)).toBeTruthy();
    });

    it('says when collection is paused', () => {
      show(makeProject({ status: 'paused' }));
      expect(screen.getByText(tp.pausedTitle)).toBeTruthy();
      expect(screen.getByText(tp.pausedDescription)).toBeTruthy();
    });

    it('remembers the project for the Overview', () => {
      show();
      expect(window.localStorage.getItem('weldpanel:last-project:ws_1')).toBe('wpp_1');
    });

    it('says when the project does not exist', () => {
      state.error = new ApiError('not found', 404);
      render(<WeldPanelProjectPage />);
      expect(screen.getByText(tp.notFound)).toBeTruthy();
      expect(screen.getByRole('link', { name: tp.back }).getAttribute('href')).toBe('/weldpanel/projects');
    });

    it('offers a retry when loading fails for another reason', async () => {
      state.error = new Error('network');
      render(<WeldPanelProjectPage />);
      expect(screen.getByText(tp.loadFailed)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
      expect(state.refetch).toHaveBeenCalledTimes(1);
    });

    it('shows a loader while loading', () => {
      state.isLoading = true;
      render(<WeldPanelProjectPage />);
      expect(screen.getByText(en.common.labels.loading)).toBeTruthy();
    });
  });

  describe('Install tab', () => {
    it('is the first tab, with the script snippet, the npm snippet and the token', () => {
      show();
      expect(screen.getByRole('tab', { name: tp.tabs.install }).getAttribute('data-state')).toBe('active');
      const install = makeInstall();
      expect(screen.getByText(install.scriptSnippet)).toBeTruthy();
      expect(screen.getByRole('region', { name: en.weldpanel.install.npmTitle }).textContent).toContain('@weldsuite/panel-sdk');
      expect(screen.getByRole('region', { name: en.weldpanel.install.tokenLabel }).textContent).toBe('wpk_abc123');
    });

    it('copies the snippet', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: `Copy ${en.weldpanel.install.scriptTitle}` }));
      expect(await navigator.clipboard.readText()).toBe(makeInstall().scriptSnippet);
      expect(await screen.findByText(en.weldpanel.install.copied)).toBeTruthy();
    });

    it('shows the status while waiting, and when events arrive', () => {
      const { unmount } = show(makeProject(), makeInstall({ status: 'waiting' }));
      expect(screen.getByText(en.weldpanel.install.waiting)).toBeTruthy();
      unmount();
      show(makeProject(), makeInstall({ status: 'receiving', lastEventAt: '2026-10-27T08:30:00.000Z' }));
      expect(screen.getByText(en.weldpanel.install.receiving)).toBeTruthy();
      expect(screen.getByText(/^Last event /)).toBeTruthy();
    });

    it('never shows a snippet that still carries a rotated-away token', () => {
      show(makeProject({ token: 'wpk_new' }), makeInstall({ token: 'wpk_old' }));
      expect(screen.queryByText(/wpk_old/)).toBeNull();
    });
  });

  describe('without permission to change anything', () => {
    it('shows the general values with no controls', async () => {
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.general }));
      expect(screen.getByText('example.com')).toBeTruthy();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: en.weldpanel.general.save })).toBeNull();
    });

    it('shows the privacy settings as values, with no controls', async () => {
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.privacy }));
      const tpv = en.weldpanel.privacy;
      expect(screen.getByText(tpv.on)).toBeTruthy();
      expect(screen.getByText(tpv.consent.required.label)).toBeTruthy();
      expect(screen.getByText(tpv.masking.balanced.label)).toBeTruthy();
      expect(screen.getByText('/admin/*')).toBeTruthy();
      expect(screen.getByText(tpv.readOnlyNote)).toBeTruthy();
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: tpv.save })).toBeNull();
    });

    it('has no danger zone', () => {
      show();
      expect(screen.queryByRole('tab', { name: tp.tabs.danger })).toBeNull();
    });

    it('is not offered the danger zone with only panel_projects:update', () => {
      state.perms = new Set([READ, 'panel_projects:update']);
      show();
      expect(screen.queryByRole('tab', { name: tp.tabs.danger })).toBeNull();
    });
  });

  describe('General tab with panel_projects:update', () => {
    beforeEach(() => {
      state.perms = new Set([READ, 'panel_projects:update']);
    });

    it('saves only what changed', async () => {
      state.update.mockResolvedValue(makeProject({ name: 'Docs' }));
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.general }));

      const save = screen.getByRole('button', { name: en.weldpanel.general.save }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);

      const name = screen.getByLabelText(en.weldpanel.general.nameLabel);
      await user.clear(name);
      await user.type(name, 'Docs');
      expect(save.disabled).toBe(false);
      await user.click(save);

      await waitFor(() => expect(state.update).toHaveBeenCalledWith({ name: 'Docs' }));
      expect(state.toast.success).toHaveBeenCalledWith(en.weldpanel.general.saved);
    });

    it('explains that an empty domain list accepts any site, and edits the list', async () => {
      state.update.mockResolvedValue(makeProject());
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.general }));
      expect(screen.getByText(en.weldpanel.general.domainsHint)).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Remove example.com' }));
      await user.click(screen.getByRole('button', { name: en.weldpanel.general.save }));
      await waitFor(() => expect(state.update).toHaveBeenCalledWith({ allowedDomains: [] }));
    });

    it('tells the user when saving fails', async () => {
      state.update.mockRejectedValue(new Error('nope'));
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.general }));
      await user.type(screen.getByLabelText(en.weldpanel.general.nameLabel), '!');
      await user.click(screen.getByRole('button', { name: en.weldpanel.general.save }));
      await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(en.weldpanel.general.saveFailed));
    });
  });

  describe('Privacy tab with panel_projects:manage', () => {
    beforeEach(() => {
      state.perms = new Set([READ, 'panel_projects:manage']);
    });

    it('shows the controls and explains consent and masking', async () => {
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.privacy }));
      const tpv = en.weldpanel.privacy;
      expect(screen.getByRole('switch', { name: tpv.autocaptureLabel }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText(tpv.consent.required.description)).toBeTruthy();
      expect(screen.getByText(tpv.maskingDescription)).toBeTruthy();
      expect(screen.getByRole('radio', { name: new RegExp(tpv.consent.required.label) }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('radio', { name: new RegExp(tpv.masking.balanced.label) }).getAttribute('aria-checked')).toBe('true');
    });

    it('saves the settings that changed', async () => {
      state.updateSettings.mockResolvedValue(makeProject());
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.privacy }));
      const tpv = en.weldpanel.privacy;

      await user.click(screen.getByRole('switch', { name: tpv.autocaptureLabel }));
      await user.click(screen.getByRole('radio', { name: new RegExp(tpv.consent.none.label) }));
      await user.click(screen.getByRole('radio', { name: new RegExp(tpv.masking.strict.label) }));
      await user.click(screen.getByRole('button', { name: tpv.save }));

      await waitFor(() => expect(state.updateSettings).toHaveBeenCalledTimes(1));
      expect(state.updateSettings).toHaveBeenCalledWith({
        settings: { autocapture: false, consentMode: 'none', maskingLevel: 'strict' },
      });
      expect(state.toast.success).toHaveBeenCalledWith(tpv.saved);
    });

    it('refuses an excluded pattern that does not start with a slash', async () => {
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.privacy }));
      await user.type(screen.getByPlaceholderText(en.weldpanel.privacy.excludedPlaceholder), 'admin{Enter}');
      expect(await screen.findByText(en.weldpanel.validation.patternInvalid)).toBeTruthy();
    });

    it('adds and removes excluded patterns', async () => {
      state.updateSettings.mockResolvedValue(makeProject());
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.privacy }));
      await user.type(screen.getByPlaceholderText(en.weldpanel.privacy.excludedPlaceholder), '/checkout/*{Enter}');
      await user.click(screen.getByRole('button', { name: 'Remove /admin/*' }));
      await user.click(screen.getByRole('button', { name: en.weldpanel.privacy.save }));
      await waitFor(() => expect(state.updateSettings).toHaveBeenCalledWith({ settings: { excludedUrls: ['/checkout/*'] } }));
    });
  });

  describe('Danger zone', () => {
    it('lets a manager pause collection after a confirm', async () => {
      state.perms = new Set([READ, 'panel_projects:manage']);
      state.updateSettings.mockResolvedValue(makeProject({ status: 'paused' }));
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      const td = en.weldpanel.danger;

      expect(screen.queryByRole('button', { name: td.delete.button })).toBeNull();
      await user.click(screen.getByRole('button', { name: td.pause.button }));
      expect(state.updateSettings).not.toHaveBeenCalled();
      await user.click(await screen.findByRole('button', { name: td.pause.confirm }));
      await waitFor(() => expect(state.updateSettings).toHaveBeenCalledWith({ status: 'paused' }));
      expect(state.toast.success).toHaveBeenCalledWith(td.pause.done);
    });

    it('resumes a paused project without asking', async () => {
      state.perms = new Set([READ, 'panel_projects:manage']);
      state.updateSettings.mockResolvedValue(makeProject());
      const { user } = show(makeProject({ status: 'paused' }));
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      await user.click(screen.getByRole('button', { name: en.weldpanel.danger.resume.button }));
      await waitFor(() => expect(state.updateSettings).toHaveBeenCalledWith({ status: 'active' }));
    });

    it('warns that the old snippet stops working before it rotates the token', async () => {
      state.perms = new Set([READ, 'panel_projects:manage']);
      state.rotate.mockResolvedValue(makeProject({ token: 'wpk_new' }));
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      const td = en.weldpanel.danger;

      await user.click(screen.getByRole('button', { name: td.rotate.button }));
      const dialog = await screen.findByRole('dialog', { name: td.rotate.confirmTitle });
      expect(within(dialog).getByText(/stops working at once/)).toBeTruthy();
      expect(state.rotate).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: td.rotate.confirm }));
      await waitFor(() => expect(state.rotate).toHaveBeenCalledTimes(1));
      expect(state.toast.success).toHaveBeenCalledWith(td.rotate.done);
    });

    it('does not rotate when the confirm is cancelled', async () => {
      state.perms = new Set([READ, 'panel_projects:manage']);
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      await user.click(screen.getByRole('button', { name: en.weldpanel.danger.rotate.button }));
      await user.click(await screen.findByRole('button', { name: en.weldpanel.danger.cancel }));
      expect(state.rotate).not.toHaveBeenCalled();
    });

    it('asks for the project name before it deletes', async () => {
      state.perms = new Set([READ, 'panel_projects:delete']);
      state.remove.mockResolvedValue(undefined);
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      const td = en.weldpanel.danger;

      // Without manage there is nothing to pause or rotate.
      expect(screen.queryByRole('button', { name: td.pause.button })).toBeNull();
      expect(screen.queryByRole('button', { name: td.rotate.button })).toBeNull();

      await user.click(screen.getByRole('button', { name: td.delete.button }));
      const confirm = (await screen.findByRole('button', { name: td.delete.confirm })) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);

      const input = screen.getByLabelText('Type Marketing site to confirm');
      await user.type(input, 'Marketing');
      expect(confirm.disabled).toBe(true);
      await user.type(input, ' site');
      expect(confirm.disabled).toBe(false);

      await user.click(confirm);
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wpp_1'));
      expect(state.push).toHaveBeenCalledWith('/weldpanel/projects');
      expect(state.toast.success).toHaveBeenCalledWith(td.delete.done);
    });

    it('keeps the project and says so when deleting fails', async () => {
      state.perms = new Set([READ, 'panel_projects:delete']);
      state.remove.mockRejectedValue(new Error('nope'));
      const { user } = show();
      await user.click(screen.getByRole('tab', { name: tp.tabs.danger }));
      await user.click(screen.getByRole('button', { name: en.weldpanel.danger.delete.button }));
      await user.type(await screen.findByLabelText('Type Marketing site to confirm'), 'Marketing site');
      await user.click(screen.getByRole('button', { name: en.weldpanel.danger.delete.confirm }));
      await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(en.weldpanel.danger.delete.failed));
      expect(state.push).not.toHaveBeenCalled();
    });
  });

  it('renders in Dutch', async () => {
    state.locale = 'nl';
    state.perms = new Set([READ, 'panel_projects:manage', 'panel_projects:delete']);
    const { user } = show();
    const dutch = nl.weldpanel;
    expect(screen.getByRole('tab', { name: dutch.project.tabs.install })).toBeTruthy();
    expect(screen.getByRole('tab', { name: dutch.project.tabs.privacy })).toBeTruthy();
    expect(screen.getByText(dutch.install.scriptTitle)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: dutch.project.tabs.privacy }));
    expect(screen.getByText(dutch.privacy.consent.required.label)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: dutch.project.tabs.danger }));
    expect(screen.getByRole('button', { name: dutch.danger.rotate.button })).toBeTruthy();
  });
});
