import { describe, expect, it } from 'vitest';
import { applyInboundFieldMappings } from './field-mapper';

describe('applyInboundFieldMappings', () => {
  it('formats a date as a Date, which a timestamp column takes', () => {
    const values = applyInboundFieldMappings(
      { due_date: '2026-03-15', reference: 'PO-1', bad_date: 'not a date' },
      { reference: 'mapped' },
      [
        { externalFieldPath: 'due_date', internalFieldPath: 'dueDate', direction: 'inbound', transformType: 'format_date' },
        { externalFieldPath: 'bad_date', internalFieldPath: 'paidAt', direction: 'inbound', transformType: 'format_date' },
        { externalFieldPath: 'reference', internalFieldPath: 'reference', direction: 'outbound', transformType: 'direct' },
      ],
    );
    expect(values.dueDate).toEqual(new Date('2026-03-15T00:00:00.000Z'));
    // What isn't a date stays as it came; an outbound mapping doesn't import.
    expect(values.paidAt).toBe('not a date');
    expect(values.reference).toBe('mapped');
  });
});
