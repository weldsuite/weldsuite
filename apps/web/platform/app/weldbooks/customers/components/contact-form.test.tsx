import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => perms.granted.has(key) }) }));

const jurisdiction = vi.hoisted(() => ({
  value: {
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID' },
    code: 'US',
    usesIban: false,
    features: { form1099: true, salesTax: true },
  } as Record<string, unknown>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useJurisdictionLabels: () => jurisdiction.value }));

vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => `date:${value}`,
    formatDateTime: (value: string) => `datetime:${value}`,
    formatMoney: (value: number) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({ uploadFile: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { ContactForm, type ContactFormContact, type ContactPayload } from './contact-form';

const supplier: ContactFormContact = {
  id: 'c1',
  role: 'supplier',
  name: 'Acme Plumbing',
  companyName: 'Acme Plumbing LLC',
  email: 'billing@acme.test',
  is1099Vendor: true,
  default1099Form: 'nec',
  default1099Box: 'nec_1',
  tinType: 'ein',
  tinLast4: '6789',
  tinMasked: '**-***6789',
  hasTin: true,
  w9: { legalName: 'Acme Plumbing LLC', federalTaxClassification: 'llc', llcTaxClassification: 'S', receivedAt: '2026-02-01' },
  backupWithholding: false,
  achRoutingNumber: '021000021',
  achAccountLast4: '4321',
  hasAchAccount: true,
  achAccountType: 'checking',
  bankDetailsChangedAt: '2026-09-01T10:00:00.000Z',
  bankDetailsNeedVerification: true,
  billingAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
};

function renderForm(contact: ContactFormContact | undefined = supplier) {
  const onSubmit = vi.fn<(payload: ContactPayload) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ContactForm mode="edit" contact={contact} isPending={false} onSubmit={onSubmit} onCancel={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onSubmit };
}

/** Radix Select and Dialog use pointer-capture APIs jsdom does not implement. */
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  perms.granted = new Set(['tax_ids:reveal', 'banking:manage', 'suppliers:update']);
  jurisdiction.value = {
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID' },
    code: 'US',
    usesIban: false,
    features: { form1099: true, salesTax: true },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const save = () => screen.getByRole('button', { name: /save changes/i });

describe('ContactForm: tax reporting on a US vendor', () => {
  it('shows the stored TIN masked, never in full, with no input to edit it', () => {
    renderForm();
    expect(screen.getByTestId('tin-value').textContent).toBe('**-***6789');
    expect(screen.queryByLabelText(/^TIN$/)).toBeNull();
    expect(screen.queryByLabelText('New TIN')).toBeNull();
    expect(document.body.textContent).not.toMatch(/12-3456789/);
  });

  it('shows the stored ACH account masked', () => {
    renderForm();
    expect(screen.getByTestId('ach-account-value').textContent).toBe('•••• 4321');
  });

  it('does not send tin or achAccountNumber when they were left alone: blank means unchanged', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0];
    expect('tin' in payload).toBe(false);
    expect('tinType' in payload).toBe(false);
    expect('achAccountNumber' in payload).toBe(false);
    expect(payload.is1099Vendor).toBe(true);
    expect(payload.default1099Form).toBe('nec');
    expect(payload.default1099Box).toBe('nec_1');
  });

  it('sends the TIN only after it was typed, with its type and the dashes of the type', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(within(screen.getByTestId('tin-stored')).getByRole('button', { name: 'Replace' }));
    const input = screen.getByLabelText('New TIN');
    await user.type(input, '123456789');
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.tin).toBe('12-3456789');
    expect(payload.tinType).toBe('ein');
  });

  it('hides what is typed as a password does, until the eye is pressed', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(within(screen.getByTestId('tin-stored')).getByRole('button', { name: 'Replace' }));
    const input = screen.getByLabelText('New TIN') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    await user.click(screen.getByRole('button', { name: 'Show what you typed' }));
    expect(input.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Hide what you typed' }));
    expect(input.type).toBe('password');
  });

  it('refuses a TIN that is not valid for its type and does not submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(within(screen.getByTestId('tin-stored')).getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('New TIN'), '00-1234567');
    await user.click(save());
    expect(await screen.findByText(/not an EIN prefix the IRS issues/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends null to remove the stored TIN', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(within(screen.getByTestId('tin-stored')).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('The TIN is removed when you save.')).toBeTruthy();
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].tin).toBeNull();
  });

  it('requires the tax classification of an LLC', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ ...supplier, w9: { legalName: 'Acme', federalTaxClassification: 'llc' } });
    await user.click(save());
    expect(await screen.findByText('Choose how the LLC is taxed.')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('checks the ABA routing number', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    const routing = screen.getByLabelText('Routing number');
    await user.clear(routing);
    await user.type(routing, '123456789');
    await user.click(save());
    expect(await screen.findByText(/does not pass the check/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the payment hold of changed bank details, and lets someone with permission verify them', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { ...supplier, bankDetailsNeedVerification: false } });
    renderForm();
    expect(screen.getByText('Bank details need to be verified')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mark as verified' }));
    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/accounting-contacts/c1/verify-bank-details'));
  });

  it('does not offer to verify bank details without the banking permission', () => {
    perms.granted = new Set();
    renderForm();
    expect(screen.queryByRole('button', { name: 'Mark as verified' })).toBeNull();
    expect(screen.getByText('Someone with permission to manage banking has to verify them.')).toBeTruthy();
  });
});

describe('ContactForm: revealing the TIN', () => {
  it('fetches the full TIN on the click, shows it, and hides it again after 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.post.mockResolvedValue({ data: { tin: '12-3456789', tinType: 'ein' } });
    renderForm();
    const stored = within(screen.getByTestId('tin-stored'));
    fireEvent.click(stored.getByRole('button', { name: 'Reveal' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('tin-value').textContent).toBe('12-3456789');
    expect(api.post).toHaveBeenCalledWith('/accounting-contacts/c1/reveal-tin', {});
    expect(screen.getByText('Hides in 30 s')).toBeTruthy();

    // One second at a time: each tick re-renders and schedules the next one.
    for (let second = 0; second < 31; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(screen.getByTestId('tin-value').textContent).toBe('**-***6789');
  });

  it('offers no reveal without the tax ID permission', () => {
    perms.granted = new Set();
    renderForm();
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reveal history' })).toBeNull();
    expect(screen.getByTestId('tin-value').textContent).toBe('**-***6789');
  });

  it('says so when the TIN could not be revealed, and keeps it hidden', async () => {
    api.post.mockRejectedValue(new Error('Forbidden'));
    renderForm();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]!);
    expect(await screen.findByText('The TIN could not be revealed.')).toBeTruthy();
    expect(screen.getByTestId('tin-value').textContent).toBe('**-***6789');
  });
});

describe('ContactForm: sections that only apply to the US', () => {
  it('hides the tax reporting and ACH sections for an entity without 1099 reporting', () => {
    jurisdiction.value = {
      labels: { supplier: 'Supplier', taxId: 'VAT number', registrationId: 'KvK' },
      code: 'NL',
      usesIban: true,
      features: { form1099: false, salesTax: false },
    };
    renderForm();
    expect(screen.queryByText('Tax reporting')).toBeNull();
    expect(screen.queryByText('ACH bank details')).toBeNull();
    expect(screen.queryByLabelText('Use')).toBeNull();
  });

  it('sends none of the vendor tax fields for an entity without 1099 reporting', async () => {
    jurisdiction.value = {
      labels: { supplier: 'Supplier', taxId: 'VAT number', registrationId: 'KvK' },
      code: 'NL',
      usesIban: true,
      features: { form1099: false, salesTax: false },
    };
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(save());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0];
    for (const key of ['is1099Vendor', 'tin', 'w9', 'backupWithholding', 'achRoutingNumber', 'achAccountNumber', 'taxUse']) {
      expect(key in payload).toBe(false);
    }
  });

  it('hides the tax reporting section for a customer-only contact', () => {
    renderForm({ ...supplier, role: 'customer' });
    expect(screen.queryByText('Tax reporting')).toBeNull();
    // A customer of a US entity gets the sales tax default instead.
    expect(screen.getByLabelText('Use')).toBeTruthy();
  });
});
