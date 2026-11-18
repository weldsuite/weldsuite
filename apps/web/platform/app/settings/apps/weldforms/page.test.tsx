import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  canManage: true,
  settings: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn() },
  themes: { data: [] as unknown[], isLoading: false },
  usage: { data: undefined as unknown },
  createTheme: vi.fn(),
  updateTheme: vi.fn(),
  deleteTheme: vi.fn(),
  updateSettings: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => m.canManage }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: locale, language: 'en', format: interpolate }) };
});
vi.mock('@/hooks/queries/use-weldforms-queries', () => ({
  useFormsSettings: () => m.settings,
  useFormThemes: () => m.themes,
  useFormsUsage: () => m.usage,
  useCreateFormTheme: () => ({ mutateAsync: m.createTheme, isPending: false }),
  useUpdateFormTheme: () => ({ mutate: m.updateTheme, mutateAsync: m.updateTheme, isPending: false }),
  useDeleteFormTheme: () => ({ mutateAsync: m.deleteTheme, isPending: false }),
  useUpdateFormsSettings: () => ({ mutateAsync: m.updateSettings, isPending: false }),
}));
vi.mock('@/app/weldforms/components/form-preview', () => ({ FormPreview: () => <div>form preview</div> }));
vi.mock('@/app/weldforms/components/theme-tokens-editor', () => ({
  ThemeSwatch: () => <span>swatch</span>,
  ThemeTokensEditor: () => <div>tokens editor</div>,
}));

import WeldFormsSettingsPage from './page';

const tw = en.weldforms.workspaceSettings;

/** FormField labels are not tied to their inputs, so find the input in the label's field wrapper. */
function input(label: string, root: HTMLElement = document.body): HTMLInputElement {
  const text = within(root).getByText(label);
  return text.closest('div.mb-2')!.parentElement!.querySelector('input')!;
}

const baseSettings = {
  defaultThemeId: 'th_1',
  senderName: 'Acme Forms',
  reminderAfterDays: 3,
  reminderEveryDays: 2,
  reminderMaxCount: 1,
  showBadge: true,
  canHideBadge: true,
};

const themeList = [
  { id: 'th_1', name: 'Brand', tokens: {} },
  { id: 'th_2', name: 'Dark', tokens: {} },
];

describe('WeldForms settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.canManage = true;
    m.settings = { data: { ...baseSettings }, isLoading: false, error: null, refetch: vi.fn() };
    m.themes = { data: themeList, isLoading: false };
    m.usage = { data: undefined };
    m.createTheme.mockResolvedValue({});
    m.updateTheme.mockResolvedValue({});
    m.deleteTheme.mockResolvedValue(undefined);
    m.updateSettings.mockResolvedValue({});
  });

  it('shows a loader while loading', () => {
    m.settings = { ...m.settings, isLoading: true };
    render(<WeldFormsSettingsPage />);
    expect(screen.queryByText(tw.title)).toBeNull();
  });

  it('shows an error state and retries', async () => {
    m.settings = { data: undefined, isLoading: false, error: new Error('x'), refetch: vi.fn() };
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(en.weldforms.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.retry }));
    expect(m.settings.refetch).toHaveBeenCalled();
  });

  it('lists themes with the default marked and no manage controls for read-only members', () => {
    m.canManage = false;
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(tw.readOnly)).toBeTruthy();
    expect(screen.getByText('Brand')).toBeTruthy();
    expect(screen.getByText('Dark')).toBeTruthy();
    expect(screen.getAllByText(tw.defaultBadge)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: tw.newTheme })).toBeNull();
    expect(screen.queryByRole('button', { name: en.common.actions.save })).toBeNull();
    expect((input(tw.senderName) as HTMLInputElement).disabled).toBe(true);
  });

  it('shows the empty themes message', () => {
    m.themes = { data: [], isLoading: false };
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(tw.noThemes)).toBeTruthy();
  });

  it('makes a theme the default and toasts the result', async () => {
    render(<WeldFormsSettingsPage />);
    // Only the non-default theme offers "make default".
    await userEvent.click(screen.getByRole('button', { name: tw.makeDefault }));
    expect(m.updateTheme).toHaveBeenCalledWith({ id: 'th_2', isDefault: true }, expect.any(Object));
    const opts = m.updateTheme.mock.calls[0]![1] as { onSuccess: () => void; onError: () => void };
    opts.onSuccess();
    opts.onError();
    expect(m.toastSuccess).toHaveBeenCalledWith(tw.defaultSet);
    expect(m.toastError).toHaveBeenCalledWith(tw.saveFailed);
  });

  it('creates a theme from the dialog', async () => {
    render(<WeldFormsSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: tw.newTheme }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: en.common.actions.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(input(tw.themeName, dialog), '  Fresh  ');
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(m.createTheme).toHaveBeenCalledWith({ name: 'Fresh', tokens: expect.any(Object) }));
    expect(m.toastSuccess).toHaveBeenCalledWith(tw.themeSaved);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits a theme and keeps the dialog open when saving fails', async () => {
    m.updateTheme.mockRejectedValue(new Error('boom'));
    render(<WeldFormsSettingsPage />);
    const row = screen.getByText('Dark').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: en.common.actions.edit }));
    const dialog = await screen.findByRole('dialog');
    const nameInput = input(tw.themeName, dialog);
    expect(nameInput.value).toBe("Dark");
    await userEvent.type(nameInput, " 2");
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.actions.save }));
    await waitFor(() => expect(m.updateTheme).toHaveBeenCalledWith({ id: 'th_2', name: 'Dark 2', tokens: expect.any(Object) }));
    expect(m.toastError).toHaveBeenCalledWith(tw.saveFailed);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('deletes a theme after confirming', async () => {
    render(<WeldFormsSettingsPage />);
    const row = screen.getByText('Dark').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: en.common.actions.delete }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(tw.deleteThemeDescription.replace('{name}', 'Dark'))).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.actions.delete }));
    await waitFor(() => expect(m.deleteTheme).toHaveBeenCalledWith('th_2'));
    expect(m.toastSuccess).toHaveBeenCalledWith(tw.themeDeleted);
  });

  it('toasts when deleting a theme fails', async () => {
    m.deleteTheme.mockRejectedValue(new Error('no'));
    render(<WeldFormsSettingsPage />);
    const row = screen.getByText('Brand').closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: en.common.actions.delete }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.actions.delete }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(tw.deleteThemeFailed));
  });

  it('saves the sender name and reminder defaults, enabling save only when changed', async () => {
    render(<WeldFormsSettingsPage />);
    const save = screen.getByRole('button', { name: en.common.actions.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const sender = input(tw.senderName) as HTMLInputElement;
    expect(sender.value).toBe('Acme Forms');
    await userEvent.clear(sender);
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(m.updateSettings).toHaveBeenCalled());
    expect(m.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ senderName: null, reminderAfterDays: 3, reminderEveryDays: 2, reminderMaxCount: 1, showBadge: true }),
    );
    expect(m.toastSuccess).toHaveBeenCalledWith(tw.saved);
  });

  it('trims the sender name and toasts when saving fails', async () => {
    m.updateSettings.mockRejectedValue(new Error('no'));
    render(<WeldFormsSettingsPage />);
    const sender = input(tw.senderName);
    await userEvent.clear(sender);
    await userEvent.type(sender, '  Team  ');
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
    await waitFor(() => expect(m.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'Team' })));
    expect(m.toastError).toHaveBeenCalledWith(tw.saveFailed);
  });

  it('edits the reminder number inputs', async () => {
    render(<WeldFormsSettingsPage />);
    const after = input(tw.reminderAfter);
    await userEvent.clear(after);
    await userEvent.type(after, '9');
    const max = input(tw.reminderMax);
    await userEvent.clear(max);
    await userEvent.type(max, '4');
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
    await waitFor(() => expect(m.updateSettings).toHaveBeenCalled());
    const body = m.updateSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.reminderAfterDays).toBe(9);
    expect(body.reminderMaxCount).toBe(4);
  });

  it('toggles the badge when the plan allows hiding it', async () => {
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(tw.showBadgeHelp)).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: tw.showBadge }));
    await userEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
    await waitFor(() => expect(m.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ showBadge: false })));
  });

  it('locks the badge on plans that cannot hide it', () => {
    m.settings = { ...m.settings, data: { ...baseSettings, showBadge: false, canHideBadge: false } };
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(tw.showBadgeLocked)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: tw.showBadge }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('shows limited usage with a progress bar and plan', () => {
    m.usage = { data: { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-30T00:00:00Z', used: 25, limit: 100, plan: 'Pro' } };
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText(tw.usage)).toBeTruthy();
    expect(screen.getByText('25 of 100')).toBeTruthy();
    expect(screen.getByText('Plan: Pro')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('shows unlimited usage without a progress bar', () => {
    m.usage = { data: { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-30T00:00:00Z', used: 7, limit: null, plan: null } };
    render(<WeldFormsSettingsPage />);
    expect(screen.getByText('7, no limit')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
