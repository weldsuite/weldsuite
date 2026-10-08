import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import type { JurisdictionSummary } from '@/lib/weldbooks/jurisdiction';

const mocks = vi.hoisted(() => ({
  entity: undefined as unknown,
  updateEntity: vi.fn(),
  applyTaxLines: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canRevealTaxIds: true,
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'ent_us' }),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => (permission === 'tax_ids:reveal' ? mocks.canRevealTaxIds : true),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: () => ({ data: mocks.entity, isLoading: false, isError: false, refetch: vi.fn() }),
  useAccountingJurisdictions: () => ({ data: jurisdictions }),
  useUpdateAccountingEntity: () => ({ mutateAsync: mocks.updateEntity, isPending: false }),
  useApplyTaxLines: () => ({ mutateAsync: mocks.applyTaxLines, isPending: false }),
  useTaxLineCatalog: () => ({ data: undefined }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useTerminologyLabels: () => ({ taxId: 'EIN', registrationId: 'State registration number' }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { revealEntitySsn: vi.fn() } }));
vi.mock('./components/lock-dates-card', () => ({ LockDatesCard: () => <div data-testid="lock-dates" /> }));
vi.mock('./components/lock-exceptions-card', () => ({ LockExceptionsCard: () => <div data-testid="lock-exceptions" /> }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import EditEntityPage from './edit-page';

const usEntityTypes = [
  {
    type: 'multi_member_llc',
    label: 'LLC with two or more members',
    description: '',
    minOwners: 2,
    defaultClassification: 'partnership',
    classifications: [
      { value: 'partnership', form: 'f1065', formLabel: 'Form 1065' },
      { value: 's_corp', form: 'f1120s', formLabel: 'Form 1120-S' },
    ],
  },
  {
    type: 'c_corp',
    label: 'C corporation',
    description: '',
    minOwners: 1,
    defaultClassification: 'c_corp',
    classifications: [{ value: 'c_corp', form: 'f1120', formLabel: 'Form 1120' }],
  },
];

const features = {
  vatReturn: false,
  icp: false,
  xafExport: false,
  smallBusinessScheme: false,
  gstReturn: false,
  salesTax: true,
  form1099: true,
};

const jurisdictions: JurisdictionSummary[] = [
  {
    code: 'US',
    name: 'United States',
    defaultLocale: 'en-US',
    defaultCurrency: 'USD',
    features,
    terminology: { tax: 'sales_tax', taxId: 'ein', registrationId: 'state_id', supplier: 'vendor', creditNote: 'credit_memo' },
    entityTypes: usEntityTypes,
  },
  {
    code: 'NL',
    name: 'Netherlands',
    defaultLocale: 'nl-NL',
    defaultCurrency: 'EUR',
    features: { ...features, salesTax: false, form1099: false, vatReturn: true },
    terminology: { tax: 'vat', taxId: 'vat_number', registrationId: 'kvk', supplier: 'supplier', creditNote: 'credit_note' },
  },
];

const usEntity: AccountingEntity = {
  id: 'ent_us',
  name: 'Acme',
  legalName: 'Acme LLC',
  entityType: 'multi_member_llc',
  taxClassification: 'partnership',
  dba: 'Acme Co',
  accountingMethod: 'cash',
  jurisdictionCode: 'US',
  baseCurrency: 'USD',
  timezone: 'America/Chicago',
  fiscalYearStart: 7,
  fiscalYearConfig: null,
  hasSsn: true,
  ssnLast4: '6789',
  taxIdentifiers: { einOrSsn: '12-3456789', vatNumber: '12-3456789', registrationNumber: 'TX-99' },
  address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

describe('EditEntityPage (US entity)', () => {
  beforeEach(() => {
    mocks.entity = usEntity;
    mocks.canRevealTaxIds = true;
    mocks.updateEntity.mockReset();
    mocks.applyTaxLines.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.updateEntity.mockResolvedValue({ data: { ...usEntity } });
  });

  it('shows the legal form, EIN, accounting method and fiscal year of the entity', () => {
    render(<EditEntityPage />);

    expect(screen.getByRole('combobox', { name: 'Entity type' })).toHaveTextContent('LLC with two or more members');
    expect(screen.getByRole('combobox', { name: 'Tax classification' })).toHaveTextContent('Partnership — Form 1065');
    expect(screen.getByRole('textbox', { name: 'EIN' })).toHaveValue('12-3456789');
    expect(screen.getByRole('textbox', { name: 'State tax ID' })).toHaveValue('TX-99');
    expect(screen.getByLabelText('Doing business as (DBA)')).toHaveValue('Acme Co');
    expect(screen.getByRole('combobox', { name: 'Accounting method' })).toHaveTextContent('Cash');
    expect(screen.getByRole('combobox', { name: 'Starts in' })).toHaveTextContent('July');
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveTextContent('Central Time (Chicago)');
    // The stored SSN is masked, and this member may reveal it.
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
    // The state comes from the picker, and the generic tax identifier card is replaced by the US one.
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveTextContent('Texas (TX)');
    expect(screen.getAllByText('Tax identifiers')).toHaveLength(1);
  });

  it('treats the address of a US entity without a country as a US address, so the state is a picker', () => {
    mocks.entity = { ...usEntity, address: { line1: '1 Main St', state: 'TX' } };
    render(<EditEntityPage />);
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveTextContent('Texas (TX)');
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveTextContent('United States');
  });

  it('offers no reveal button without the tax_ids:reveal permission', () => {
    mocks.canRevealTaxIds = false;
    render(<EditEntityPage />);
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument();
    expect(screen.getByTestId('ssn-display')).toHaveTextContent('•••-••-6789');
  });

  it('saves only what changed in the tax identifiers and sends the US setup', async () => {
    const user = userEvent.setup();
    render(<EditEntityPage />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.updateEntity).toHaveBeenCalledTimes(1));
    const { id, data } = mocks.updateEntity.mock.calls[0][0];
    expect(id).toBe('ent_us');
    expect(data).toMatchObject({
      name: 'Acme',
      legalName: 'Acme LLC',
      entityType: 'multi_member_llc',
      taxClassification: 'partnership',
      dba: 'Acme Co',
      accountingMethod: 'cash',
      fiscalYearStart: 7,
      timezone: 'America/Chicago',
      address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    });
    // Neither the EIN nor the state ID changed, and no SSN was typed.
    expect(data).not.toHaveProperty('taxIdentifiers');
    expect(data).not.toHaveProperty('ssn');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Entity updated');
  });

  it('sends a changed EIN, a removed SSN and a 52–53-week year', async () => {
    const user = userEvent.setup();
    render(<EditEntityPage />);

    const ein = screen.getByRole('textbox', { name: 'EIN' });
    await user.clear(ein);
    await user.type(ein, '987654321');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('combobox', { name: 'Fiscal year' }));
    await user.click(await screen.findByRole('option', { name: '52–53 weeks' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.updateEntity).toHaveBeenCalledTimes(1));
    const { data } = mocks.updateEntity.mock.calls[0][0];
    expect(data.taxIdentifiers).toEqual({ einOrSsn: '98-7654321' });
    expect(data.ssn).toBeNull();
    expect(data.fiscalYearConfig).toEqual({ type: 'fifty_two_fifty_three', endMonth: 12, weekday: 0, rule: 'last' });
    expect(data.fiscalYearStart).toBe(1);
  });

  it('blocks an invalid EIN before it reaches the server', async () => {
    const user = userEvent.setup();
    render(<EditEntityPage />);
    const ein = screen.getByRole('textbox', { name: 'EIN' });
    await user.clear(ein);
    await user.type(ein, '12345');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter the EIN as XX-XXXXXXX (9 digits)')).toBeInTheDocument();
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it('offers to remap the tax lines when the change moved the entity to another return', async () => {
    const user = userEvent.setup();
    mocks.updateEntity.mockResolvedValue({
      data: { ...usEntity, taxClassification: 's_corp', taxLineRemapNeeded: true },
    });
    mocks.applyTaxLines.mockResolvedValue({
      data: {
        form: 'f1120s',
        formLabel: 'Form 1120-S',
        taxYear: 2026,
        updated: 2,
        unchanged: 30,
        keptOverrides: 1,
        changes: [{ accountId: 'acc_1', code: '6100', name: 'Advertising', from: 'f1065.20', to: 'f1120s.16' }],
        unmapped: [{ accountId: 'acc_2', code: '6900', name: 'Miscellaneous' }],
      },
    });
    render(<EditEntityPage />);

    await user.click(screen.getByRole('combobox', { name: 'Tax classification' }));
    await user.click(await screen.findByRole('option', { name: 'S corporation — Form 1120-S' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remap tax lines?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('This entity now files Form 1120-S.');
    expect(mocks.applyTaxLines).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Remap tax lines' }));

    await waitFor(() => expect(mocks.applyTaxLines).toHaveBeenCalledWith({ entityId: 'ent_us', data: { overwrite: true } }));
    expect(await screen.findByText('Tax lines remapped')).toBeInTheDocument();
    expect(screen.getByText('2 updated, 30 unchanged, 1 kept as you set them.')).toBeInTheDocument();
    expect(screen.getByText('Advertising')).toBeInTheDocument();
    expect(screen.getByText(/Without a tax line \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open tax line mapping' })).toHaveAttribute('href', '/weldbooks/accounts/tax-lines');
  });

  it('does not open the remap dialog when the return stayed the same', async () => {
    const user = userEvent.setup();
    render(<EditEntityPage />);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateEntity).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('EditEntityPage (non-US entity)', () => {
  it('keeps the existing form without the US cards', () => {
    mocks.entity = {
      id: 'ent_nl',
      name: 'Weld BV',
      entityType: 'bv',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      taxIdentifiers: { vatNumber: 'NL123456789B01' },
    } satisfies AccountingEntity;
    render(<EditEntityPage />);

    expect(screen.queryByRole('combobox', { name: 'Tax classification' })).not.toBeInTheDocument();
    expect(screen.queryByText('Legal form and tax return')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Doing business as (DBA)')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fiscal-year-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Entity type' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Fiscal year starts in' })).toBeInTheDocument();
  });
});
