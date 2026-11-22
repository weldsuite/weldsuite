import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  settings: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  mutate: vi.fn(),
  canManage: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (key: string) => key === 'settings:manage' && m.canManage }),
}));
vi.mock('@/hooks/queries/use-crm-settings-queries', () => ({
  useCrmSettings: () => m.settings,
  useUpdateCrmSettings: () => ({ mutate: m.mutate, isPending: false }),
}));

import { AutoAddSettings } from './auto-add-settings';

const ta = en.crm.settings.autoAdd;

function settings(enabled: boolean) {
  return {
    autoAdd: {
      enabled,
      createCompanies: false,
      sources: { email: true, meetings: true, helpdesk: false },
    },
  };
}

describe('AutoAddSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.canManage = true;
    m.settings = { data: settings(false), isLoading: false, isError: false, refetch: vi.fn() };
  });

  it('turns auto-add on through the labelled switch', async () => {
    render(<AutoAddSettings />);
    const main = screen.getByRole('switch', { name: ta.enabledLabel });
    expect(main).toHaveAccessibleDescription(ta.enabledDescription);
    await userEvent.click(main);
    expect(m.mutate).toHaveBeenCalledWith({ autoAdd: { enabled: true } }, expect.anything());
  });

  it('keeps the sources and companies locked while auto-add is off', () => {
    render(<AutoAddSettings />);
    expect(screen.getByRole('group', { name: ta.sourcesLegend })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: ta.sources.email.label })).toBeDisabled();
    expect(screen.getByRole('switch', { name: ta.companiesLabel })).toBeDisabled();
  });

  it('saves one source and the company switch at a time', async () => {
    m.settings.data = settings(true);
    render(<AutoAddSettings />);
    const helpdesk = screen.getByRole('checkbox', { name: ta.sources.helpdesk.label });
    expect(helpdesk).not.toBeChecked();
    await userEvent.click(helpdesk);
    expect(m.mutate).toHaveBeenCalledWith({ autoAdd: { sources: { helpdesk: true } } }, expect.anything());
    await userEvent.click(screen.getByRole('switch', { name: ta.companiesLabel }));
    expect(m.mutate).toHaveBeenCalledWith({ autoAdd: { createCompanies: true } }, expect.anything());
  });

  it('tells the person whether the change was saved', async () => {
    m.mutate.mockImplementationOnce((_input, options: { onSuccess: () => void }) => options.onSuccess());
    m.mutate.mockImplementationOnce((_input, options: { onError: () => void }) => options.onError());
    render(<AutoAddSettings />);
    const main = screen.getByRole('switch', { name: ta.enabledLabel });
    await userEvent.click(main);
    expect(m.toastSuccess).toHaveBeenCalledWith(ta.saved);
    await userEvent.click(main);
    expect(m.toastError).toHaveBeenCalledWith(ta.saveFailed);
  });

  it('shows nothing to change while the settings load', () => {
    m.settings = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    render(<AutoAddSettings />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('is read-only without settings:manage', () => {
    m.canManage = false;
    m.settings.data = settings(true);
    render(<AutoAddSettings />);
    expect(screen.getByRole('switch', { name: ta.enabledLabel })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: ta.sources.email.label })).toBeDisabled();
  });

  it('offers a retry when the settings cannot be read', async () => {
    m.settings = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    render(<AutoAddSettings />);
    expect(screen.getByText(ta.loadFailed)).toBeInTheDocument();
  });
});
