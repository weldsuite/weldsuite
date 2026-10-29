import { describe, expect, it } from 'vitest';
import { approvalStateOf } from './approval-state';

const now = Date.parse('2026-10-20T10:00:00Z');
const old = '2026-10-20T08:00:00Z';
const fresh = '2026-10-20T09:59:30Z';

describe('approvalStateOf', () => {
  it('waits while the approval is pending', () => {
    expect(approvalStateOf('apr_1', new Set(['apr_1']), {}, old, now)).toBe('waiting');
  });

  it('reports how a decided approval ended', () => {
    const decided = { apr_1: 'approved', apr_2: 'rejected' } as const;
    expect(approvalStateOf('apr_1', new Set(), decided, old, now)).toBe('approved');
    expect(approvalStateOf('apr_2', new Set(), decided, old, now)).toBe('rejected');
  });

  it('keeps waiting while the decisions have not been read yet', () => {
    expect(approvalStateOf('apr_1', new Set(), undefined, old, now)).toBe('waiting');
  });

  it('gives a brand new approval the benefit of a stale list', () => {
    expect(approvalStateOf('apr_3', new Set(), {}, fresh, now)).toBe('waiting');
  });

  it('falls back to "handled" for an old approval that ended another way', () => {
    expect(approvalStateOf('apr_3', new Set(), {}, old, now)).toBe('handled');
  });
});
