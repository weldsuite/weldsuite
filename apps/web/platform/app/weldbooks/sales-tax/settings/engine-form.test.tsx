import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { useSalesTaxSettings } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { EngineForm } from './engine-form';
import { installPointerPolyfills, makeSettings, renderWithProviders } from '../setup/test-support';

const te = en.weldbooksUs.salesTax.setup.engine;
const SECRET = 'rk_live_SUPER_SECRET_123456';

/** The form as the settings page mounts it: the saved settings come from the query, a save updates the query. */
function Harness({ canUpdate = true }: Readonly<{ canUpdate?: boolean }>) {
  const settings = useSalesTaxSettings();
  return settings.data ? <EngineForm settings={settings.data} canUpdate={canUpdate} /> : null;
}

function serve(settings: ReturnType<typeof makeSettings>) {
  api.get.mockImplementation(async () => ({ data: settings }));
}

async function renderForm(settings: ReturnType<typeof makeSettings>, canUpdate = true) {
  serve(settings);
  const view = renderWithProviders(<Harness canUpdate={canUpdate} />);
  await screen.findByRole('radiogroup');
  return view;
}

/** Every text and value a person could read off the page. */
function visibleText(): string {
  const values = Array.from(document.querySelectorAll('input, textarea')).map((el) => (el as HTMLInputElement).value);
  return `${document.body.textContent ?? ''} ${values.join(' ')}`;
}

const stripeStored = makeSettings({ engine: 'stripe_tax', hasCredentials: true });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('EngineForm: stored credentials', () => {
  it('shows that credentials are stored and never their value, with no field to read from', async () => {
    await renderForm(stripeStored);

    expect(screen.getByTestId('credentials-stored')).toHaveTextContent(te.credentials.stored);
    expect(screen.getByText(te.credentials.storedHelp)).toBeInTheDocument();
    expect(screen.queryByLabelText(te.stripe.apiKey)).not.toBeInTheDocument();
    for (const input of document.querySelectorAll('input[type="password"]')) expect(input).toHaveValue('');
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('starts the replacement field empty, and clears it after the key is saved', async () => {
    const user = userEvent.setup();
    await renderForm(stripeStored);
    api.put.mockResolvedValue({ data: stripeStored });

    await user.click(screen.getByRole('button', { name: te.credentials.replace }));
    const input = screen.getByLabelText(te.stripe.apiKey);
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');

    await user.type(input, SECRET);
    await user.click(screen.getByRole('button', { name: te.save }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/sales-tax/settings', { engine: 'stripe_tax', credentials: { apiKey: SECRET } });

    // Back to "stored": the key is gone from the page, the field included.
    expect(await screen.findByTestId('credentials-stored')).toBeInTheDocument();
    expect(screen.queryByLabelText(te.stripe.apiKey)).not.toBeInTheDocument();
    expect(visibleText()).not.toContain(SECRET);
    expect(toast.success).toHaveBeenCalledWith(te.saved);
  });

  it('keeps the stored credentials when only the engine settings change: no credentials in the request', async () => {
    const user = userEvent.setup();
    const avalaraStored = makeSettings({
      engine: 'avalara',
      hasCredentials: true,
      config: { companyCode: 'WELD', environment: 'production' },
    });
    await renderForm(avalaraStored);
    api.put.mockResolvedValue({ data: { ...avalaraStored, config: { companyCode: 'WELD', environment: 'sandbox' } } });

    expect(screen.getByLabelText(te.avalara.companyCode)).toHaveValue('WELD');
    await user.click(screen.getByRole('combobox', { name: te.avalara.environment }));
    await user.click(await screen.findByRole('option', { name: te.avalara.sandbox }));
    await user.click(screen.getByRole('button', { name: te.save }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1]).toEqual({ engine: 'avalara', config: { companyCode: 'WELD', environment: 'sandbox' } });
  });

  it('removes the stored credentials by switching back to manual', async () => {
    const user = userEvent.setup();
    await renderForm(stripeStored);
    api.put.mockResolvedValue({ data: makeSettings() });

    await user.click(screen.getByRole('button', { name: te.credentials.remove }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(te.credentials.removeDialog.description);
    await user.click(within(dialog).getByRole('button', { name: te.credentials.removeDialog.confirm }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/sales-tax/settings', { engine: 'manual', credentials: null });
    await waitFor(() => expect(screen.queryByTestId('credentials-stored')).not.toBeInTheDocument());
    expect(screen.getByTestId('manual-warning')).toBeInTheDocument();
  });

  it('does not offer replace or remove to a member who cannot update', async () => {
    await renderForm(stripeStored, false);
    expect(screen.getByTestId('credentials-stored')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: te.credentials.replace })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: te.credentials.remove })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: te.save })).not.toBeInTheDocument();
  });
});

describe('EngineForm: choosing an engine', () => {
  it('says plainly that manual rates are the user\'s responsibility', async () => {
    await renderForm(makeSettings());
    const warning = screen.getByTestId('manual-warning');
    expect(warning).toHaveTextContent(te.manualWarning.title);
    expect(warning).toHaveTextContent('If you sell in many states, use Stripe Tax or Avalara');
  });

  it('asks for the Stripe key when none is stored and does not call the API without it', async () => {
    const user = userEvent.setup();
    await renderForm(makeSettings());

    await user.click(screen.getByRole('radio', { name: /Stripe Tax/ }));
    expect(screen.queryByTestId('manual-warning')).not.toBeInTheDocument();
    expect(screen.getByText(te.credentials.notStored)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: te.save }));

    expect(await screen.findByText(en.weldbooksUs.salesTax.setup.validation.apiKey)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('shows empty Avalara fields for an engine whose credentials are not stored, even if another engine has some', async () => {
    const user = userEvent.setup();
    await renderForm(stripeStored);

    await user.click(screen.getByRole('radio', { name: /Avalara/ }));

    expect(screen.queryByTestId('credentials-stored')).not.toBeInTheDocument();
    expect(screen.getByLabelText(te.avalara.accountId)).toHaveValue('');
    expect(screen.getByLabelText(te.avalara.licenseKey)).toHaveValue('');
    expect(screen.getByLabelText(te.avalara.licenseKey)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(te.avalara.companyCode)).toHaveValue('');
  });

  it('sends the Avalara account, license key, company code and environment together', async () => {
    const user = userEvent.setup();
    await renderForm(makeSettings());
    api.put.mockResolvedValue({
      data: makeSettings({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'sandbox' } }),
    });

    await user.click(screen.getByRole('radio', { name: /Avalara/ }));
    await user.type(screen.getByLabelText(te.avalara.accountId), '1100012345');
    await user.type(screen.getByLabelText(te.avalara.licenseKey), 'LICENSE-XYZ-987');
    await user.type(screen.getByLabelText(te.avalara.companyCode), 'WELD');
    await user.click(screen.getByRole('combobox', { name: te.avalara.environment }));
    await user.click(await screen.findByRole('option', { name: te.avalara.sandbox }));
    await user.click(screen.getByRole('button', { name: te.save }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/sales-tax/settings', {
      engine: 'avalara',
      config: { companyCode: 'WELD', environment: 'sandbox' },
      credentials: { accountId: '1100012345', licenseKey: 'LICENSE-XYZ-987' },
    });
    expect(await screen.findByTestId('credentials-stored')).toBeInTheDocument();
    expect(visibleText()).not.toContain('LICENSE-XYZ-987');
  });

  it('refuses half of the Avalara credentials', async () => {
    const user = userEvent.setup();
    await renderForm(makeSettings());

    await user.click(screen.getByRole('radio', { name: /Avalara/ }));
    await user.type(screen.getByLabelText(te.avalara.accountId), '1100012345');
    await user.type(screen.getByLabelText(te.avalara.companyCode), 'WELD');
    await user.click(screen.getByRole('button', { name: te.save }));

    expect(await screen.findByText(en.weldbooksUs.salesTax.setup.validation.bothCredentials)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('keeps the save button off until something changed', async () => {
    const user = userEvent.setup();
    await renderForm(stripeStored);
    expect(screen.getByRole('button', { name: te.save })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Manual/ }));
    expect(screen.getByRole('button', { name: te.save })).toBeEnabled();
  });

  it('shows the server sentence when saving fails, and keeps what was typed so it can be retried', async () => {
    const user = userEvent.setup();
    await renderForm(makeSettings());
    api.put.mockRejectedValue(new Error('Encryption is not configured, so engine credentials can not be stored'));

    await user.click(screen.getByRole('radio', { name: /Stripe Tax/ }));
    await user.type(screen.getByLabelText(te.stripe.apiKey), SECRET);
    await user.click(screen.getByRole('button', { name: te.save }));

    expect(await screen.findByText(/Encryption is not configured/)).toBeInTheDocument();
    expect(screen.getByLabelText(te.stripe.apiKey)).toHaveValue(SECRET);
  });
});
