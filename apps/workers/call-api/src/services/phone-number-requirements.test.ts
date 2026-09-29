import { describe, expect, it } from 'vitest';
import {
  flattenOrderingRequirements,
  telnyxOrderNeedsDocuments,
} from './phone-number-requirements';

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
