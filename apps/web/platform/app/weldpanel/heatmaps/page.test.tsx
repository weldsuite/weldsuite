import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { DATA_AS_OF } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import HeatmapsPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(),
  groups: { data: undefined as unknown, isLoading: false, error: null },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelHeatmapPages: () => state.groups,
  useCreateWeldPanelHeatmapPage: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelHeatmapPage: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteWeldPanelHeatmapPage: () => ({ mutateAsync: state.remove, isPending: false }),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const th = en.weldpanel.observe.heatmaps;
const ALL = ['panel_reports:create', 'panel_reports:update', 'panel_reports:delete', 'panel_recordings:read'];
const group = (id: string, name: string, urlPattern: string) => ({ id, projectId: 'wpp_1', name, urlPattern, createdByUserId: 'u', createdAt: DATA_AS_OF, updatedAt: DATA_AS_OF });
const products = group('wphp_1', 'Product pages', '/products/*');
const blog = group('wphp_2', 'Blog', '/blog/*');

/** Opens a row's menu and picks an item. */
async function rowMenu(item: string) {
  await userEvent.click(screen.getAllByRole('button', { name: en.common.actions.title })[0]!);
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Heatmaps: the page groups list', () => {
  beforeEach(() => {
    state.perms = new Set(ALL);
    state.groups = { data: [products, blog], isLoading: false, error: null };
    for (const fn of [state.create, state.update, state.remove, state.push, state.toast.success, state.toast.error]) fn.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the page groups with their URL patterns', () => {
    render(<HeatmapsPage />);
    expect(screen.getByText('Product pages')).toBeTruthy();
    expect(screen.getByText('/products/*')).toBeTruthy();
    expect(screen.getByText('Blog')).toBeTruthy();
    expect(screen.getByText('/blog/*')).toBeTruthy();
  });

  it("opens a page group's heatmap from its row", async () => {
    render(<HeatmapsPage />);
    await userEvent.click(screen.getAllByRole('button', { name: en.common.actions.view })[0]!);
    expect(state.push).toHaveBeenCalledWith('/weldpanel/heatmaps/wphp_1');
  });

  it('finds a page group by its pattern', async () => {
    render(<HeatmapsPage />);
    await userEvent.type(screen.getAllByPlaceholderText(th.search)[0]!, '/blog');
    await waitFor(() => expect(screen.queryByText('Product pages')).toBeNull());
    expect(screen.getByText('Blog')).toBeTruthy();
  });

  it('starts from an empty project with a way to make the first page group, then opens its heatmap', async () => {
    state.groups = { data: [], isLoading: false, error: null };
    state.create.mockResolvedValue({ ...blog, id: 'wphp_new' });
    render(<HeatmapsPage />);
    expect(screen.getByText(th.noGroupsTitle)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: th.newPageGroup })[0]!);
    await userEvent.type(screen.getByLabelText(th.dialog.name), 'Blog');
    await userEvent.type(screen.getByLabelText(th.dialog.pattern), '/blog/*');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ projectId: 'wpp_1', name: 'Blog', urlPattern: '/blog/*' }));
    expect(state.toast.success).toHaveBeenCalledWith(th.saved);
    expect(state.push).toHaveBeenCalledWith('/weldpanel/heatmaps/wphp_new');
  });

  it('refuses a pattern that does not start with a slash', async () => {
    render(<HeatmapsPage />);
    await userEvent.click(screen.getByRole('button', { name: th.newPageGroup }));
    await userEvent.type(screen.getByLabelText(th.dialog.name), 'Blog');
    await userEvent.type(screen.getByLabelText(th.dialog.pattern), 'blog');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    expect(await screen.findByText(en.weldpanel.validation.patternInvalid)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('edits a page group from its row menu', async () => {
    state.update.mockResolvedValue(products);
    render(<HeatmapsPage />);
    await rowMenu(en.common.actions.edit);
    const pattern = screen.getByLabelText(th.dialog.pattern);
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '/shop/*');
    await userEvent.click(screen.getByRole('button', { name: th.dialog.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'wphp_1', name: 'Product pages', urlPattern: '/shop/*' }));
    expect(state.push).not.toHaveBeenCalled();
  });

  it('deletes a page group from its row menu after a confirmation', async () => {
    state.remove.mockResolvedValue(undefined);
    render(<HeatmapsPage />);
    await rowMenu(en.common.actions.delete);
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: th.deleteConfirm }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('wphp_1'));
    expect(state.toast.success).toHaveBeenCalledWith(th.deleted);
  });

  it('shows only opening to people without the permissions', () => {
    state.perms = new Set(['panel_recordings:read']);
    render(<HeatmapsPage />);
    expect(screen.queryByRole('button', { name: th.newPageGroup })).toBeNull();
    expect(screen.queryByRole('button', { name: en.common.actions.title })).toBeNull();
    expect(screen.getAllByRole('button', { name: en.common.actions.view })).toHaveLength(2);
  });
});
