import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getTranslations } from '@/lib/i18n';

const m = vi.hoisted(() => ({
  settings: { data: undefined as unknown, isLoading: false },
  mutateAsync: vi.fn(),
  isPending: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommercePortalSettings: () => m.settings,
  useUpdateCommercePortalSettings: () => ({ mutateAsync: m.mutateAsync, isPending: m.isPending }),
}));

import { CustomerPortalSection } from './portal-section';
import WeldCommerceSettingsPage from './page';

const t = getTranslations('commerce').module.portal;
const tv = getTranslations('commerce').module.validation;

const data = {
  isEnabled: false,
  portalUrl: 'https://portal.example.com/acme',
  displayName: 'Acme Portal',
  logo: 'https://cdn.example.com/logo.png',
  primaryColor: '#112233',
  accentColor: '#abc',
};

describe('WeldCommerce customer portal settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.isPending = false;
    m.settings = { data: { ...data }, isLoading: false };
    m.mutateAsync.mockResolvedValue({});
  });

  it('renders the page title and the portal section', () => {
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t.title })).toBeTruthy();
  });

  it('fills the fields from the saved settings', () => {
    render(<CustomerPortalSection />);
    expect((screen.getByLabelText(t.displayName) as HTMLInputElement).value).toBe('Acme Portal');
    expect((screen.getByLabelText(t.logo) as HTMLInputElement).value).toBe(data.logo);
    expect((screen.getByLabelText(t.primaryColor) as HTMLInputElement).value).toBe('#112233');
    expect((screen.getByLabelText(t.accentColor) as HTMLInputElement).value).toBe('#abc');
    expect(screen.getByDisplayValue(data.portalUrl)).toBeTruthy();
  });

  it('switches the portal on and toasts', async () => {
    render(<CustomerPortalSection />);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(m.mutateAsync).toHaveBeenCalledWith({ isEnabled: true }));
    expect(m.toastSuccess).toHaveBeenCalledWith(t.saved);
  });

  it('toasts an error when switching fails', async () => {
    m.mutateAsync.mockRejectedValue(new Error('no'));
    render(<CustomerPortalSection />);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(t.saveFailed));
  });

  it('disables the switch while loading', () => {
    m.settings = { data: undefined, isLoading: true };
    render(<CustomerPortalSection />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies the portal URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CustomerPortalSection />);
    await userEvent.click(screen.getByRole('button', { name: t.copyUrl }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(data.portalUrl));
    expect(m.toastSuccess).toHaveBeenCalledWith(t.copied);
  });

  it('disables copy and shows a placeholder when there is no portal URL', () => {
    m.settings = { data: { ...data, portalUrl: null }, isLoading: false };
    render(<CustomerPortalSection />);
    expect((screen.getByRole('button', { name: t.copyUrl }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByDisplayValue(t.noSlug)).toBeTruthy();
  });

  it('saves the edited look, trimming values and nulling empty ones', async () => {
    render(<CustomerPortalSection />);
    const name = screen.getByLabelText(t.displayName);
    await userEvent.clear(name);
    await userEvent.type(name, 'New name');
    await userEvent.clear(screen.getByLabelText(t.logo));
    await userEvent.clear(screen.getByLabelText(t.primaryColor));
    await userEvent.type(screen.getByLabelText(t.primaryColor), '  #FFF ');
    await userEvent.click(screen.getByRole('button', { name: t.save }));
    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({ displayName: 'New name', logo: null, primaryColor: '#FFF', accentColor: '#abc' }),
    );
    expect(m.toastSuccess).toHaveBeenCalledWith(t.saved);
  });

  it('blocks saving and shows validation errors for a bad logo URL and colours', async () => {
    render(<CustomerPortalSection />);
    expect(screen.queryByText(tv.invalidUrl)).toBeNull();
    await userEvent.clear(screen.getByLabelText(t.logo));
    await userEvent.type(screen.getByLabelText(t.logo), 'not a url');
    await userEvent.clear(screen.getByLabelText(t.primaryColor));
    await userEvent.type(screen.getByLabelText(t.primaryColor), 'blue');
    await userEvent.clear(screen.getByLabelText(t.accentColor));
    await userEvent.type(screen.getByLabelText(t.accentColor), '#12');
    await userEvent.click(screen.getByRole('button', { name: t.save }));
    expect(m.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(tv.invalidUrl)).toBeTruthy();
    expect(screen.getAllByText(tv.color)).toHaveLength(2);
    expect(screen.getByLabelText(t.logo).getAttribute('aria-invalid')).toBe('true');

    // The errors clear live as the person fixes the fields.
    await userEvent.clear(screen.getByLabelText(t.logo));
    expect(screen.queryByText(tv.invalidUrl)).toBeNull();
  });

  it('toasts when saving the look fails', async () => {
    m.mutateAsync.mockRejectedValue(new Error('no'));
    render(<CustomerPortalSection />);
    await userEvent.click(screen.getByRole('button', { name: t.save }));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith(t.saveFailed));
  });
});
