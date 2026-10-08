import { describe, it, expect } from 'vitest';
import type { Entity } from '@weldsuite/db/schema';
import { generateInvoiceHtml, type InvoiceRenderData } from './accounting-invoice-html';

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'ent_test',
    name: 'Weld BV',
    legalName: 'Weld B.V.',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    locale: 'nl-NL',
    address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
    taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' },
    branding: null,
    ...overrides,
  } as Entity;
}

function invoice(overrides: Partial<InvoiceRenderData> = {}): InvoiceRenderData {
  return {
    invoiceNumber: 'INV-0001',
    type: 'standard',
    issueDate: '2026-10-01T00:00:00.000Z',
    dueDate: '2026-10-31T00:00:00.000Z',
    currency: 'EUR',
    contactName: 'Acme Corp',
    items: [{ description: 'Consulting', quantity: '2', unitPrice: '100', taxRate: '21', lineTotal: '200' }],
    subtotal: '200',
    discountTotal: '0',
    taxTotal: '42',
    total: '242',
    ...overrides,
  };
}

/** The buyer column: from the "bill to" label to the end of its block. */
function buyerBlock(html: string, billToLabel: string): string {
  const start = html.indexOf(billToLabel);
  return html.slice(start, html.indexOf('</div>\n  </div>', start));
}

describe('generateInvoiceHtml · addresses', () => {
  it('prints a legacy (street + houseNumber, province) billing address in the shared layout', () => {
    const html = generateInvoiceHtml(
      invoice({
        billingAddress: { street: 'Keizersgracht', houseNumber: '100', postalCode: '1015 AA', city: 'Amsterdam', province: 'Noord-Holland', country: 'NL' },
      }),
      entity(),
    );
    const buyer = buyerBlock(html, 'Factureren aan');
    expect(buyer).toContain('Keizersgracht 100<br>1015 AA Amsterdam<br>Noord-Holland');
    // Domestic invoice: no country line for the buyer.
    expect(buyer).not.toContain('<br>NL');
  });

  it('prints the state on a US address and the country on a cross-border invoice', () => {
    const html = generateInvoiceHtml(
      invoice({
        billingAddress: { line1: '500 Main St', line2: 'Suite 4', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      }),
      entity({ locale: 'en-US' }),
    );
    expect(html).toContain('500 Main St<br>Suite 4<br>Austin, TX 78701<br>US');
    // The seller's country shows too, since the buyer is abroad.
    expect(html).toContain('Damrak 1<br>1012 LG Amsterdam<br>NL');
  });

  it('uses the adapter "from" label in the entity locale', () => {
    expect(generateInvoiceHtml(invoice(), entity({ locale: 'en-US' }))).toContain('>From</div>');
    expect(generateInvoiceHtml(invoice(), entity({ locale: 'nl-NL' }))).toContain('>Van</div>');
  });

  it('adds a ship-to block only when the shipping address differs from billing', () => {
    const billingAddress = { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' };

    const same = generateInvoiceHtml(
      invoice({
        billingAddress,
        // Same address in the legacy shape: not a separate ship-to.
        shippingAddress: { street: 'Damrak', houseNumber: '1', postalCode: '1012 LG', city: 'Amsterdam', country: 'nl' },
      }),
      entity({ locale: 'en-US' }),
    );
    expect(same).not.toContain('Ship to');

    const none = generateInvoiceHtml(invoice({ billingAddress }), entity({ locale: 'en-US' }));
    expect(none).not.toContain('Ship to');

    const different = generateInvoiceHtml(
      invoice({ billingAddress, shippingAddress: { line1: 'Warehouse 7', postalCode: '3011 AA', city: 'Rotterdam', country: 'NL' } }),
      entity({ locale: 'en-US' }),
    );
    expect(different).toContain('Ship to');
    expect(different).toContain('Warehouse 7<br>3011 AA Rotterdam');
  });
});

describe('generateInvoiceHtml · escaping (TASK-634)', () => {
  it('escapes every address line, buyer and seller', () => {
    const html = generateInvoiceHtml(
      invoice({
        billingAddress: { line1: '<script>alert(1)</script>', city: '"><img src=x onerror=alert(2)>', country: 'NL' },
        shippingAddress: { line1: '<b>ship</b>', city: 'Utrecht', country: 'NL' },
      }),
      entity({ address: { line1: '<iframe src=evil>', city: 'Amsterdam', country: 'NL' } }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>ship</b>');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;ship&lt;/b&gt;');
  });

  it('escapes item quantity, unit and tax rate', () => {
    const html = generateInvoiceHtml(
      invoice({
        items: [{ description: 'x', quantity: '1<i>', unit: '<u>hr</u>', unitPrice: '1', taxRate: '21<s>', lineTotal: '1' }],
      }),
      entity(),
    );
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<u>hr</u>');
    expect(html).not.toContain('21<s>');
  });

  it('only accepts plain colour values and http(s)/inline logo URLs from branding', () => {
    const html = generateInvoiceHtml(
      invoice(),
      entity({
        branding: {
          primaryColor: 'red;background:url(https://evil.example/x)',
          accentColor: '"><script>alert(3)</script>',
          logoUrl: 'javascript:alert(4)',
        },
      }),
    );
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('<script>alert(3)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('#1a1a2e');

    const branded = generateInvoiceHtml(
      invoice(),
      entity({ branding: { primaryColor: '#0055ff', logoUrl: 'https://cdn.example/logo.png' } }),
    );
    expect(branded).toContain('color:#0055ff');
    expect(branded).toContain('src="https://cdn.example/logo.png"');
  });

  it('keeps printing IBAN/BIC and account/routing numbers', () => {
    const nl = generateInvoiceHtml(invoice(), entity());
    expect(nl).toContain('IBAN: <strong>NL91ABNA0417164300</strong>');
    expect(nl).toContain('BIC: ABNANL2A');

    const us = generateInvoiceHtml(
      invoice(),
      entity({ bankDetails: { accountNumber: '000123456789', routingNumber: '021000021' } }),
    );
    expect(us).toContain('Account: <strong>000123456789</strong>');
    expect(us).toContain('Routing: 021000021');
  });
});
