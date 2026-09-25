import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flattenOrderingRequirements,
  submitNumberOrderRequirements,
  telnyxOrderNeedsDocuments,
} from './phone-number-requirements';
import type { TelnyxEnv } from '../lib/telnyx';

describe('flattenOrderingRequirements', () => {
  it('pulls nested requirement_types out of a parent requirement', () => {
    const flat = flattenOrderingRequirements([
      {
        record_type: 'requirement',
        country_code: 'NL',
        requirements: [
          {
            id: 'req_address',
            record_type: 'requirement_type',
            name: 'Local address',
            type: 'address',
            description: 'A Dutch business address',
          },
          {
            id: 'req_doc',
            name: 'Chamber of commerce extract',
            type: 'document',
            description: 'KvK extract',
          },
        ],
      },
    ]);
    expect(flat.map((r) => r.id)).toEqual(['req_address', 'req_doc']);
    expect(flat[0]?.fieldType).toBe('address');
    expect(flat[1]?.fieldType).toBe('document');
  });
});

describe('telnyxOrderNeedsDocuments', () => {
  it('is true when Telnyx says requirements are not met', () => {
    expect(
      telnyxOrderNeedsDocuments({
        phone_numbers: [{ phone_number: '+31201234567', requirements_met: false }],
      }),
    ).toBe(true);
  });

  it('is false when the order is fully approved', () => {
    expect(
      telnyxOrderNeedsDocuments({
        phone_numbers: [{ phone_number: '+31201234567', requirements_met: true }],
      }),
    ).toBe(false);
  });
});

describe('submitNumberOrderRequirements', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes the encoded order id with the requirement values', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { requirements_met: true } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitNumberOrderRequirements(
      { TELNYX_API_KEY: 'key' } as TelnyxEnv,
      { phoneNumberOrderId: 'ord/../x', values: [{ requirementId: 'req_1', fieldValue: 'val' }] },
    );

    expect(result).toEqual({ requirementsMet: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/number_order_phone_numbers\/ord%2F\.\.%2Fx$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      regulatory_requirements: [{ requirement_id: 'req_1', field_value: 'val' }],
    });
  });
});
