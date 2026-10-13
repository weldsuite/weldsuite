import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  setWeldbooksEntityId: vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => false }) }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    // A Dutch entity: its own words are KvK and VAT number.
    labels: { supplier: 'Supplier', taxId: 'VAT number', registrationId: 'Chamber of Commerce (KvK) number' },
    code: 'NL',
    usesIban: true,
    features: { form1099: false, salesTax: false },
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (v: string) => v, formatMoney: (v: number) => `${v}`, today: () => '2026-10-08' }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({ uploadFile: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { ContactForm, type ContactFormContact, type ContactPayload } from './contact-form';

const contact = (country: string, extra: Partial<ContactFormContact> = {}): ContactFormContact =>
  ({
    id: 'c1',
    role: 'customer',
    name: 'Acme',
    companyName: 'Acme',
    billingAddress: { line1: 'Street 1', city: 'City', postalCode: '1000', country },
    ...extra,
  }) as ContactFormContact;

function renderForm(c: ContactFormContact) {
  const onSubmit = vi.fn<(payload: ContactPayload) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ContactForm mode="edit" contact={c} isPending={false} onSubmit={onSubmit} onCancel={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onSubmit };
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(cleanup);

describe('ContactForm · tax and registration labels follow the contact country', () => {
  it('a Dutch contact has a KvK number', () => {
    renderForm(contact('NL'));
    expect(screen.getByLabelText('Chamber of Commerce (KvK) number')).toBeInTheDocument();
    expect(screen.getByLabelText('VAT number')).toBeInTheDocument();
  });

  it('a Belgian contact of a Dutch company has an enterprise number (KBO/BCE), not a KvK number', () => {
    renderForm(contact('BE'));
    expect(screen.getByLabelText('Enterprise number (KBO/BCE)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/KvK/)).not.toBeInTheDocument();
  });

  it('another EU contact has a company registration number', () => {
    renderForm(contact('DE'));
    expect(screen.getByLabelText('Company registration number')).toBeInTheDocument();
    expect(screen.queryByLabelText(/KvK/)).not.toBeInTheDocument();
  });

  it('a US contact has a Tax ID and no registration number field', () => {
    renderForm(contact('US'));
    expect(screen.getByLabelText('Tax ID')).toBeInTheDocument();
    expect(screen.queryByLabelText(/registration number|KvK|Enterprise/)).not.toBeInTheDocument();
  });

  it('a US contact that already has a registration number keeps showing it', () => {
    renderForm(contact('US', { registrationNumber: 'TX-123' } as Partial<ContactFormContact>));
    expect(screen.getByDisplayValue('TX-123')).toBeInTheDocument();
  });
});

describe('ContactForm · VAT number and IBAN checks', () => {
  it('refuses BE0123 for a Belgian contact and saves a valid number', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(contact('BE', { vatNumber: 'BE0123' } as Partial<ContactFormContact>));

    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Not a valid VAT number for BE\. Example: BE0123456789/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    const field = screen.getByLabelText('VAT number');
    await user.clear(field);
    await user.type(field, 'BE0123456789');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].vatNumber).toBe('BE0123456789');
  });

  it('refuses NL00 BANK 1234 as an IBAN', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(contact('NL', { iban: 'NL00 BANK 1234' } as Partial<ContactFormContact>));

    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Not a valid IBAN/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    const field = screen.getByLabelText('IBAN');
    await user.clear(field);
    await user.type(field, 'NL91ABNA0417164300');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });
});
