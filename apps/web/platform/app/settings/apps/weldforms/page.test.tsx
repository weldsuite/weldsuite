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
  domainsAvailable: false,
  config: { data: undefined as unknown, isLoading: false, error: null as unknown, refetch: vi.fn() },
  domains: { data: [] as unknown[], isLoading: false, error: null as unknown, refetch: vi.fn() },
  addDomain: vi.fn(),
  refreshDomain: vi.fn(),
  makePrimary: vi.fn(),
  updateDomain: vi.fn(),
  removeDomain: vi.fn(),
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
  useFormDomainsConfig: () => m.config,
  useFormDomains: () => m.domains,
  useForms: () => ({ forms: [{ id: 'f_1', title: 'Contact', publicId: 'pub1' }, { id: 'f_2', title: 'Draft only', publicId: null }] }),
  useAddFormDomain: () => ({ mutateAsync: m.addDomain, isPending: false }),
  useRefreshFormDomain: () => ({ mutateAsync: m.refreshDomain, isPending: false }),
  useMakeFormDomainPrimary: () => ({ mutateAsync: m.makePrimary, isPending: false }),
  useUpdateFormDomain: () => ({ mutateAsync: m.updateDomain, isPending: false }),
  useRemoveFormDomain: () => ({ mutateAsync: m.removeDomain, isPending: false }),
  formDomainErrorCode: (err: unknown) => (err as { code?: string }).code ?? null,
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => m.domainsAvailable }));
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
    // jsdom lacks the pointer and scroll APIs Radix Select calls.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
    vi.clearAllMocks();
    m.canManage = true;
    m.settings = { data: { ...baseSettings }, isLoading: false, error: null, refetch: vi.fn() };
    m.themes = { data: themeList, isLoading: false };
    m.usage = { data: undefined };
    m.createTheme.mockResolvedValue({});
    m.updateTheme.mockResolvedValue({});
    m.deleteTheme.mockResolvedValue(undefined);
    m.updateSettings.mockResolvedValue({});
    m.domainsAvailable = false;
    m.config = {
      data: { available: true, cnameTarget: 'edge.weldsuite.org', apexAddresses: [], portalUrl: 'https://forms.weldsuite.org', maxDomains: 3 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    m.domains = { data: [], isLoading: false, error: null, refetch: vi.fn() };
    m.addDomain.mockResolvedValue({});
    m.refreshDomain.mockResolvedValue({});
    m.makePrimary.mockResolvedValue({});
    m.updateDomain.mockResolvedValue({});
    m.removeDomain.mockResolvedValue(undefined);
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

  describe('custom domains', () => {
    const td = en.weldforms.workspaceSettings.domains;
    const domain = {
      id: 'fd_1',
      hostname: 'forms.acme.com',
      isPrimary: false,
      status: 'pending',
      sslStatus: null,
      lastError: 'CNAME not found',
      lastCheckedAt: null,
      verifiedAt: null,
      homeFormPublicId: null,
      url: 'https://forms.acme.com',
      dnsRecords: [
        { type: 'TXT', name: '_weld-verify.forms.acme.com', value: 'weld-verify=abc', purpose: 'ownership', satisfied: true },
        { type: 'CNAME', name: 'forms.acme.com', value: 'edge.weldsuite.org', purpose: 'routing', satisfied: false },
      ],
      createdAt: '2026-11-20T00:00:00Z',
    };

    it('is hidden when the edition does not offer custom domains', () => {
      render(<WeldFormsSettingsPage />);
      expect(screen.queryByText(td.title)).toBeNull();
    });

    it('says so when the install has custom domains switched off', () => {
      m.domainsAvailable = true;
      m.config = { ...m.config, data: { available: false, cnameTarget: null, apexAddresses: [], portalUrl: '', maxDomains: 0 } };
      render(<WeldFormsSettingsPage />);
      expect(screen.getByText(td.unavailable)).toBeTruthy();
      expect(screen.queryByRole('button', { name: td.add })).toBeNull();
    });

    it('renders domains with status, last error and DNS records', () => {
      m.domainsAvailable = true;
      m.domains = { ...m.domains, data: [domain] };
      render(<WeldFormsSettingsPage />);
      expect(screen.getByRole('heading', { name: 'forms.acme.com' })).toBeTruthy();
      expect(screen.getByText(td.statusPending)).toBeTruthy();
      expect(screen.getByText('CNAME not found')).toBeTruthy();
      expect(screen.getByRole('table', { name: 'DNS records to add for forms.acme.com' })).toBeTruthy();
      expect(screen.getByText('weld-verify=abc')).toBeTruthy();
      expect(screen.getAllByText('edge.weldsuite.org').length).toBeGreaterThan(0);
      expect(screen.getByText(td.satisfied)).toBeTruthy();
      expect(screen.getByText(td.notSatisfied)).toBeTruthy();
      // Not active, so it cannot be made primary yet.
      expect(screen.queryByRole('button', { name: td.makePrimary })).toBeNull();
    });

    it('adds a domain through the client', async () => {
      m.domainsAvailable = true;
      render(<WeldFormsSettingsPage />);
      await userEvent.type(screen.getByLabelText(td.addLabel), ' Forms.Acme.com ');
      await userEvent.click(screen.getByRole('button', { name: td.add }));
      await waitFor(() => expect(m.addDomain).toHaveBeenCalledWith({ hostname: 'forms.acme.com' }));
      expect(m.toastSuccess).toHaveBeenCalledWith(td.added);
    });

    it('maps a server error code to a message', async () => {
      m.domainsAvailable = true;
      m.addDomain.mockRejectedValue({ code: 'HOST_TAKEN' });
      render(<WeldFormsSettingsPage />);
      await userEvent.type(screen.getByLabelText(td.addLabel), 'forms.acme.com');
      await userEvent.click(screen.getByRole('button', { name: td.add }));
      await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(td.errorHostTaken));
    });

    it('checks, makes primary, sets the home form and removes after confirming', async () => {
      m.domainsAvailable = true;
      m.domains = { ...m.domains, data: [{ ...domain, status: 'active', sslStatus: 'active', lastError: null }] };
      render(<WeldFormsSettingsPage />);
      await userEvent.click(screen.getByRole('button', { name: td.checkNow }));
      await waitFor(() => expect(m.refreshDomain).toHaveBeenCalledWith('fd_1'));
      await userEvent.click(screen.getByRole('button', { name: td.makePrimary }));
      await waitFor(() => expect(m.makePrimary).toHaveBeenCalledWith('fd_1'));

      await userEvent.click(screen.getByRole('combobox'));
      await userEvent.click(await screen.findByRole('option', { name: 'Contact' }));
      await waitFor(() => expect(m.updateDomain).toHaveBeenCalledWith({ id: 'fd_1', homeFormPublicId: 'pub1' }));
      expect(screen.queryByRole('option', { name: 'Draft only' })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: td.remove }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: td.remove }));
      await waitFor(() => expect(m.removeDomain).toHaveBeenCalledWith('fd_1'));
    });

    it('hides the controls from read-only members', () => {
      m.domainsAvailable = true;
      m.canManage = false;
      m.domains = { ...m.domains, data: [{ ...domain, status: 'active' }] };
      render(<WeldFormsSettingsPage />);
      expect(screen.getByRole('heading', { name: 'forms.acme.com' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: td.add })).toBeNull();
      expect(screen.queryByRole('button', { name: td.checkNow })).toBeNull();
      expect(screen.queryByRole('button', { name: td.makePrimary })).toBeNull();
      expect(screen.queryByRole('button', { name: td.remove })).toBeNull();
    });
  });
});
