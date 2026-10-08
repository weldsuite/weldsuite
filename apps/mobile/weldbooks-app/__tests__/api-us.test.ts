/**
 * The US side of the app-api adapter: what the app sends for a US entity's
 * invoices, bills, payments and contacts, and how it reads entities,
 * jurisdictions, bank accounts and contacts that carry US fields.
 */

import api, { toApiItems, toEntity, toPostalAddress } from '@/services/api';

// See api.test.ts: a plain require yields the very client instance services/api.ts captured.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require('@weldsuite/api-client/client') as {
  __client: Record<string, jest.Mock>;
  __resetClient: () => void;
};
const client = stub.__client;

function routeGet(routes: Record<string, unknown>) {
  client.get.mockImplementation((path: string) => {
    const match = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!match) throw new Error(`Unexpected GET ${path}`);
    return Promise.resolve(routes[match]);
  });
}

const EMPTY_PAGE = { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } };

beforeEach(() => {
  stub.__resetClient();
  api.setAccountingEntityCurrency(null);
});

describe('toApiItems', () => {
  it('sends a US invoice line with its tax code and no rate, so the engine calculates the tax', () => {
    const [item] = toApiItems([
      { description: 'Annual plan', quantity: 1, unitPrice: 1200, taxCode: 'saas', sortOrder: 0 },
    ]);

    expect(item).toMatchObject({
      description: 'Annual plan',
      quantity: '1',
      unitPrice: '1200',
      taxCode: 'saas',
      sortOrder: 0,
    });
    // A "0" here would read as the user overriding the engine.
    expect(item).not.toHaveProperty('taxRate');
  });

  it('sends a VAT line with its percentage', () => {
    const [item] = toApiItems([{ description: 'Consulting', unitPrice: 100, taxRate: 21 }]);
    expect(item.taxRate).toBe('21');
    expect(item).not.toHaveProperty('taxCode');
  });

  it('still sends an untaxed rate for a line that has neither a rate nor a code', () => {
    const [item] = toApiItems([{ description: 'Gift', unitPrice: 10 }]);
    expect(item.taxRate).toBe('0');
  });

  it('keeps an explicit zero rate (a US bill with no vendor tax) and adds the use tax accrual', () => {
    const [item] = toApiItems([
      { description: 'Laptop', unitPrice: 1000, taxRate: 0, accrueUseTax: true, taxCode: 'general' },
    ]);
    expect(item).toMatchObject({ taxRate: '0', accrueUseTax: true, taxCode: 'general' });
  });

  it('leaves the accrual flag off a line that does not accrue', () => {
    const [item] = toApiItems([{ description: 'Pens', unitPrice: 5, taxRate: 7.5 }]);
    expect(item).not.toHaveProperty('accrueUseTax');
    expect(item.taxRate).toBe('7.5');
  });
});

describe('toPostalAddress', () => {
  it('reads the shared shape', () => {
    expect(
      toPostalAddress({ line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' }),
    ).toEqual({
      line1: '1 Main St',
      line2: undefined,
      city: 'Springfield',
      state: 'IL',
      postalCode: '62704',
      country: 'US',
    });
  });

  it('reads the older Dutch shape (street + house number, province)', () => {
    expect(toPostalAddress({ street: 'Damrak', houseNumber: '1', city: 'Amsterdam', province: 'NH' })).toMatchObject({
      line1: 'Damrak 1',
      state: 'NH',
    });
  });

  it('returns null for nothing worth showing', () => {
    expect(toPostalAddress(null)).toBeNull();
    expect(toPostalAddress({})).toBeNull();
    expect(toPostalAddress({ line1: '  ', city: '' })).toBeNull();
    expect(toPostalAddress([])).toBeNull();
  });
});

describe('entities', () => {
  const usRow = {
    id: 'ent_us',
    name: 'Acme LLC',
    jurisdictionCode: 'US',
    baseCurrency: 'USD',
    locale: 'en-US',
    timezone: 'America/Chicago',
    entityType: 'single_member_llc',
    taxClassification: 's_corp',
    dba: 'Acme Goods',
    taxIdentifiers: { einOrSsn: '12-3456789', vatNumber: '12-3456789' },
    address: { line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' },
    isDefault: true,
  };

  it('reads the US fields of an entity', () => {
    const entity = toEntity(usRow);

    expect(entity).toMatchObject({
      id: 'ent_us',
      jurisdictionCode: 'US',
      baseCurrency: 'USD',
      locale: 'en-US',
      timezone: 'America/Chicago',
      entityType: 'single_member_llc',
      taxClassification: 's_corp',
      dba: 'Acme Goods',
      ein: '12-3456789',
    });
    expect(entity.address).toMatchObject({ state: 'IL', postalCode: '62704' });
  });

  it('never shows a masked Social Security number as an EIN', () => {
    expect(toEntity({ ...usRow, taxIdentifiers: { einOrSsn: '•••-••-6789' } }).ein).toBeUndefined();
    expect(toEntity({ ...usRow, taxIdentifiers: { einOrSsn: '123-45-6789' } }).ein).toBeUndefined();
  });

  it('defaults the currency and locale from the jurisdiction rather than to euros', () => {
    expect(toEntity({ id: 'e', name: 'Co', jurisdictionCode: 'US' })).toMatchObject({
      baseCurrency: 'USD',
      locale: 'en-US',
    });
    expect(toEntity({ id: 'e', name: 'Co', jurisdictionCode: 'IN' })).toMatchObject({
      baseCurrency: 'INR',
      locale: 'en-IN',
    });
    expect(toEntity({ id: 'e', name: 'Co' })).toMatchObject({
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      locale: 'nl-NL',
    });
  });

  it('creates a US entity with its legal form, EIN and address, and leaves the currency to the jurisdiction', async () => {
    client.post.mockResolvedValue({ data: { ...usRow } });

    const entity = await api.createEntity({
      name: 'Acme LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxClassification: 'disregarded',
      dba: 'Acme Goods',
      ein: '12-3456789',
      address: { line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' },
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/accounting-entities');
    expect(body).toMatchObject({
      name: 'Acme LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxClassification: 'disregarded',
      dba: 'Acme Goods',
      taxIdentifiers: { einOrSsn: '12-3456789' },
      address: { state: 'IL', postalCode: '62704' },
      isDefault: true,
      seedDefaults: true,
    });
    expect(body).not.toHaveProperty('baseCurrency');
    expect(body).not.toHaveProperty('vatNumber');
    expect(entity.baseCurrency).toBe('USD');
  });

  it('creates a Dutch entity with its VAT number as before', async () => {
    client.post.mockResolvedValue({ data: { id: 'ent_nl', name: 'Acme B.V.', jurisdictionCode: 'NL', baseCurrency: 'EUR' } });

    await api.createEntity({
      name: 'Acme B.V.',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      vatNumber: 'NL123456789B01',
    });

    const [, body] = client.post.mock.calls[0];
    expect(body).toMatchObject({ jurisdictionCode: 'NL', baseCurrency: 'EUR', vatNumber: 'NL123456789B01' });
    expect(body).not.toHaveProperty('taxIdentifiers');
    expect(body).not.toHaveProperty('entityType');
  });
});

describe('getJurisdictions', () => {
  it('reads features, terminology and the US legal forms', async () => {
    routeGet({
      '/accounting-entities/jurisdictions': {
        data: [
          {
            code: 'US',
            name: 'United States',
            defaultLocale: 'en-US',
            defaultCurrency: 'USD',
            features: {
              vatReturn: false,
              icp: false,
              xafExport: false,
              smallBusinessScheme: false,
              gstReturn: false,
              salesTax: true,
              form1099: true,
            },
            terminology: {
              tax: 'sales_tax',
              taxId: 'ein',
              registrationId: 'state_id',
              supplier: 'vendor',
              creditNote: 'credit_memo',
            },
            entityTypes: [
              {
                type: 'single_member_llc',
                label: 'LLC with one member',
                description: '…',
                minOwners: 1,
                defaultClassification: 'disregarded',
                classifications: [{ value: 'disregarded', form: 'sch_c', formLabel: 'Schedule C (Form 1040)' }],
              },
            ],
          },
        ],
      },
    });

    const [us] = await api.getJurisdictions();

    expect(us).toMatchObject({ code: 'US', defaultCurrency: 'USD', defaultLocale: 'en-US' });
    expect(us.features).toMatchObject({ salesTax: true, form1099: true, vatReturn: false });
    expect(us.terminology).toEqual({
      tax: 'sales_tax',
      taxId: 'ein',
      registrationId: 'state_id',
      supplier: 'vendor',
      creditNote: 'credit_memo',
    });
    expect(us.entityTypes?.[0]).toMatchObject({
      type: 'single_member_llc',
      defaultClassification: 'disregarded',
      classifications: [{ value: 'disregarded', form: 'sch_c', formLabel: 'Schedule C (Form 1040)' }],
    });
  });

  it('fills a row from an older API (no features or terminology) with the built-in values for its code', async () => {
    routeGet({
      '/accounting-entities/jurisdictions': { data: [{ code: 'nl', name: 'Netherlands' }, { code: 'US', name: 'USA' }] },
    });

    const [nl, us] = await api.getJurisdictions();

    expect(nl.code).toBe('NL');
    expect(nl.features.vatReturn).toBe(true);
    expect(nl.terminology.tax).toBe('vat');
    expect(nl.defaultCurrency).toBe('EUR');
    expect(us.features.vatReturn).toBe(false);
    expect(us.features.salesTax).toBe(true);
    expect(us.terminology.supplier).toBe('vendor');
    expect(us.entityTypes).toBeUndefined();
  });

  it('ignores a terminology code it does not know instead of passing it to the UI', async () => {
    routeGet({
      '/accounting-entities/jurisdictions': {
        data: [{ code: 'US', name: 'USA', terminology: { tax: 'turnover_tax', supplier: 'vendor' } }],
      },
    });

    const [us] = await api.getJurisdictions();

    expect(us.terminology.tax).toBe('sales_tax');
    expect(us.terminology.supplier).toBe('vendor');
  });
});

describe('currency defaults', () => {
  it('shows rows that carry no currency in the active entity currency, not euros', async () => {
    api.setAccountingEntityCurrency('USD');
    routeGet({
      '/accounting-dashboard': { data: {} },
      '/invoices': EMPTY_PAGE,
    });

    const dashboard = await api.getDashboard();

    expect(dashboard.currency).toBe('USD');
  });

  it('applies to bank accounts and balances too', async () => {
    api.setAccountingEntityCurrency('USD');
    routeGet({
      '/bank-accounts': { data: [{ id: 'ba_1', name: 'Operating', currentBalance: '100' }] },
      '/accounting-contacts/con_1/balance': { data: { receivable: '5' } },
    });

    const [account] = await api.getBankAccounts();
    const balance = await api.getContactBalance('con_1');

    expect(account.currency).toBe('USD');
    expect(balance.currency).toBe('USD');
  });

  it('keeps a currency the row carries', async () => {
    api.setAccountingEntityCurrency('USD');
    routeGet({ '/bank-accounts': { data: [{ id: 'ba_1', name: 'Euro', currency: 'EUR' }] } });

    const [account] = await api.getBankAccounts();

    expect(account.currency).toBe('EUR');
  });
});

describe('createInvoice (US)', () => {
  it('sends the ship-to and bill-to addresses and the tax code, with no rate', async () => {
    routeGet({ '/accounting-contacts': { data: [{ id: 'con_1', displayName: 'Acme' }] } });
    client.post.mockResolvedValue({ data: { id: 'inv_us' } });
    const shipTo = { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
    const billTo = { state: 'NY', postalCode: '10001', country: 'US' };

    await api.createInvoice({
      contactName: 'Acme',
      issueDate: '2026-10-08',
      dueDate: '2026-11-07',
      shippingAddress: shipTo,
      billingAddress: billTo,
      items: [{ description: 'Subscription', quantity: 1, unitPrice: 99, taxCode: 'saas' }],
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/invoices');
    expect(body.shippingAddress).toEqual(shipTo);
    expect(body.billingAddress).toEqual(billTo);
    expect(body.items[0]).toMatchObject({ taxCode: 'saas', unitPrice: '99' });
    expect(body.items[0]).not.toHaveProperty('taxRate');
  });

  it('sends no addresses for a Dutch invoice', async () => {
    routeGet({ '/accounting-contacts': { data: [{ id: 'con_1', displayName: 'Acme' }] } });
    client.post.mockResolvedValue({ data: { id: 'inv_nl' } });

    await api.createInvoice({
      contactName: 'Acme',
      issueDate: '2026-10-08',
      dueDate: '2026-11-07',
      items: [{ description: 'Work', unitPrice: 10, taxRate: 21 }],
    });

    const [, body] = client.post.mock.calls[0];
    expect(body).not.toHaveProperty('shippingAddress');
    expect(body).not.toHaveProperty('billingAddress');
  });
});

describe('createBill (US)', () => {
  it('sends the delivery address and the use tax accrual', async () => {
    routeGet({ '/accounting-contacts': { data: [{ id: 'con_1', displayName: 'Dell' }] } });
    client.post.mockResolvedValue({ data: { id: 'bill_us' } });

    await api.createBill({
      contactName: 'Dell',
      issueDate: '2026-10-08',
      dueDate: '2026-11-07',
      deliveryAddress: { state: 'WA', postalCode: '98101', country: 'US' },
      items: [{ description: 'Laptop', unitPrice: 1500, taxRate: 0, accrueUseTax: true, taxCode: 'general' }],
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/bills');
    expect(body.deliveryAddress).toEqual({ state: 'WA', postalCode: '98101', country: 'US' });
    expect(body.items[0]).toMatchObject({ accrueUseTax: true, taxCode: 'general', taxRate: '0' });
  });
});

describe('previewSalesTax', () => {
  it('asks the server to calculate a draft and reads the breakdown back', async () => {
    client.post.mockResolvedValue({
      data: {
        engine: 'stripe_tax',
        warnings: ['address_unverified'],
        shipToState: 'TX',
        shipToPostalCode: '78701',
        addressIncomplete: false,
        subtotal: '100.00',
        discountTotal: '0.00',
        taxTotal: '8.25',
        total: '108.25',
        jurisdictions: [],
        taxBreakdown: [
          { taxRateName: 'Texas', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25, jurisdictionLevel: 'state', stateCode: 'TX' },
          { taxRateName: 'Austin', taxRate: 2, taxableAmount: 100, taxAmount: 2, jurisdictionLevel: 'city', stateCode: 'TX' },
        ],
      },
    });

    const preview = await api.previewSalesTax({
      kind: 'invoice',
      contactId: 'con_1',
      issueDate: '2026-10-08',
      shippingAddress: { state: 'TX', postalCode: '78701', country: 'US' },
      items: [{ description: 'Widget', quantity: 1, unitPrice: 100, taxCode: 'general' }],
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/sales-tax/calculate');
    expect(body).toMatchObject({
      kind: 'invoice',
      contactId: 'con_1',
      issueDate: '2026-10-08',
      shippingAddress: { state: 'TX', postalCode: '78701' },
    });
    expect(body.items[0]).toMatchObject({ id: 'line_0', taxCode: 'general', unitPrice: '100' });
    expect(body.items[0]).not.toHaveProperty('taxRate');
    // Without a contact (a customer typed by name that does not exist yet) none is sent.
    expect(preview).toMatchObject({
      engine: 'stripe_tax',
      warnings: ['address_unverified'],
      shipToState: 'TX',
      addressIncomplete: false,
      subtotal: 100,
      taxTotal: 8.25,
      total: 108.25,
    });
    expect(preview.taxBreakdown).toHaveLength(2);
  });

  it('omits the contact when there is none', async () => {
    client.post.mockResolvedValue({ data: {} });

    const preview = await api.previewSalesTax({
      kind: 'invoice',
      issueDate: '2026-10-08',
      items: [{ description: 'Widget', unitPrice: 1, taxCode: 'general' }],
    });

    expect(client.post.mock.calls[0][1]).not.toHaveProperty('contactId');
    expect(preview).toMatchObject({ engine: null, warnings: [], taxTotal: 0, taxBreakdown: [] });
  });
});

describe('findContactId', () => {
  it('finds a contact by display name without ever creating one', async () => {
    routeGet({ '/accounting-contacts': { data: [{ id: 'con_7', displayName: 'Acme LLC' }] } });

    expect(await api.findContactId('  acme llc ')).toBe('con_7');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('returns null for no match, an empty name and a failed lookup', async () => {
    routeGet({ '/accounting-contacts': EMPTY_PAGE });
    expect(await api.findContactId('Nobody')).toBeNull();
    expect(await api.findContactId('   ')).toBeNull();

    client.get.mockRejectedValue(new Error('offline'));
    expect(await api.findContactId('Acme')).toBeNull();
  });
});

describe('recording payments (US)', () => {
  it('sends a received check with its number and where it is deposited', async () => {
    client.post.mockResolvedValue({ data: { id: 'pay_1' } });

    await api.recordInvoicePayment('inv_1', {
      amount: 250,
      date: '2026-10-08',
      paymentMethod: 'check',
      checkNumber: '1042',
      depositTo: 'undeposited_funds',
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/invoices/inv_1/record-payment');
    expect(body).toMatchObject({
      amount: '250',
      paymentMethod: 'check',
      checkNumber: '1042',
      depositTo: 'undeposited_funds',
    });
  });

  it('can send received cash straight to the bank', async () => {
    client.post.mockResolvedValue({ data: { id: 'pay_2' } });

    await api.recordInvoicePayment('inv_1', { amount: 40, paymentMethod: 'cash', depositTo: 'bank' });

    expect(client.post.mock.calls[0][1].depositTo).toBe('bank');
  });

  it('sends neither field when they were not asked for', async () => {
    client.post.mockResolvedValue({ data: { id: 'pay_3' } });

    await api.recordInvoicePayment('inv_1', { amount: 10, paymentMethod: 'ach' });

    const [, body] = client.post.mock.calls[0];
    expect(body).not.toHaveProperty('checkNumber');
    expect(body).not.toHaveProperty('depositTo');
  });

  it('sends the number of a check issued to pay a bill', async () => {
    routeGet({ '/bills/bill_1': { data: { id: 'bill_1', balanceDue: '80', contactId: 'con_9' } } });
    client.post.mockResolvedValue({ data: { id: 'pay_4' } });

    await api.recordBillPayment('bill_1', { paymentMethod: 'check', checkNumber: '2001' });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/payments');
    expect(body).toMatchObject({ type: 'sent', paymentMethod: 'check', checkNumber: '2001' });
  });
});

describe('contacts (US)', () => {
  it('reads the address, 1099 flag and the last four digits of the TIN', async () => {
    routeGet({
      '/accounting-contacts/con_1': {
        data: {
          id: 'con_1',
          displayName: 'Jane Plumbing',
          role: 'supplier',
          billingAddress: { line1: '9 Elm St', city: 'Denver', state: 'CO', postalCode: '80202' },
          is1099Vendor: true,
          tinType: 'ein',
          tinLast4: '6789',
          tinMasked: '••-•••6789',
          hasTin: true,
        },
      },
    });

    const contact = await api.getContact('con_1');

    expect(contact).toMatchObject({
      name: 'Jane Plumbing',
      type: 'supplier',
      is1099Vendor: true,
      tinType: 'ein',
      tinLast4: '6789',
      city: 'Denver',
    });
    expect(contact.billingAddress).toMatchObject({ state: 'CO', postalCode: '80202' });
  });

  it('never passes on anything but four digits as a TIN, and no TIN field at all', async () => {
    routeGet({
      '/accounting-contacts/con_2': {
        data: { id: 'con_2', displayName: 'X', tinLast4: '123456789', tin: '12-3456789', tinType: 'passport' },
      },
    });

    const contact = await api.getContact('con_2');

    expect(contact.tinLast4).toBeUndefined();
    expect(contact.tinType).toBeUndefined();
    expect(contact).not.toHaveProperty('tin');
  });

  it('creates a contact with a billing address and no tax identifiers', async () => {
    client.post.mockResolvedValue({ data: { id: 'con_3', displayName: 'Acme' } });

    await api.createContact({
      fullName: 'Acme',
      role: 'customer',
      billingAddress: { state: 'CA', postalCode: '94105', country: 'US' },
    });

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/accounting-contacts');
    expect(body.billingAddress).toEqual({ state: 'CA', postalCode: '94105', country: 'US' });
    for (const field of ['tin', 'tinType', 'is1099Vendor', 'w9', 'achAccountNumber']) {
      expect(body).not.toHaveProperty(field);
    }
  });
});

describe('bank accounts (US)', () => {
  it('reads the account type, routing number and last four digits', async () => {
    routeGet({
      '/bank-accounts': {
        data: [
          {
            id: 'ba_1',
            name: 'Operating',
            bankName: 'Chase',
            accountType: 'checking',
            routingNumber: '021000021',
            accountNumberLast4: '1234',
            currentBalance: '2500.50',
            currency: 'USD',
          },
        ],
      },
    });

    const [account] = await api.getBankAccounts();

    expect(account).toMatchObject({
      accountType: 'checking',
      routingNumber: '021000021',
      accountNumberLast4: '1234',
      balance: 2500.5,
      currency: 'USD',
    });
    expect(account.iban).toBeUndefined();
  });
});

describe('offline queue (US expense)', () => {
  it('replays the use tax accrual of a queued expense', async () => {
    routeGet({ '/accounting-contacts': EMPTY_PAGE });
    client.post.mockImplementation((path: string) => {
      if (path === '/accounting-contacts') return Promise.resolve({ data: { id: 'con_1' } });
      return Promise.resolve({ data: { id: 'bill_1' } });
    });

    await api.uploadOfflineQueue([
      {
        type: 'expense',
        data: { amount: '80', category: 'office', vendorName: 'Staples', accrueUseTax: true, taxCode: 'general' },
      },
    ]);

    const billCall = client.post.mock.calls.find(([path]) => path === '/bills');
    expect(billCall?.[1].items[0]).toMatchObject({ accrueUseTax: true, taxCode: 'general' });
  });
});

describe('default dates', () => {
  // 8:30 pm on 5 Aug in Pacific time is already the 6th in UTC. A US user's expense
  // must not be dated tomorrow.
  const eveningOfThe5th = new Date(2026, 7, 5, 20, 30, 0);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(eveningOfThe5th);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("dates a quick expense on the user's own day", async () => {
    routeGet({ '/accounting-contacts': { data: [{ id: 'con_1', displayName: 'Shell' }] } });
    client.post.mockResolvedValue({ data: { id: 'bill_1' } });

    await api.createQuickExpense({ amount: 20, category: 'transport', vendorName: 'Shell' });

    const [, body] = client.post.mock.calls[0];
    expect(body.issueDate).toBe('2026-08-05');
    expect(body.dueDate).toBe('2026-08-05');
  });

  it("dates a payment on the user's own day when none is given", async () => {
    client.post.mockResolvedValue({ data: { id: 'pay_1' } });

    await api.recordInvoicePayment('inv_1', { amount: 10 });

    expect(client.post.mock.calls[0][1].date).toBe('2026-08-05');
  });
});
