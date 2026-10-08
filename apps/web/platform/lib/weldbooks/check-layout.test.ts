import { describe, expect, it } from 'vitest';
import { getCheckLayout as domainLayout, CHECK_LAYOUTS } from '../../../../../packages/domains/books/src/us-compliance/checks';
import { CHECK_LAYOUT_IDS, getCheckLayout } from './check-layout';

describe('check layout copy', () => {
  it('knows every layout of the books domain', () => {
    expect([...CHECK_LAYOUT_IDS].sort()).toEqual(CHECK_LAYOUTS.map((l) => l.id).sort());
  });

  it.each(CHECK_LAYOUT_IDS)('puts every field of %s where the books domain does', (id) => {
    expect(getCheckLayout(id)).toEqual(domainLayout(id));
  });

  it.each(CHECK_LAYOUT_IDS)('shifts %s by the printer offsets like the books domain does', (id) => {
    const alignment = { dx: 6.5, dy: -3, micrDx: 2, micrDy: -1.5 };
    expect(getCheckLayout(id, alignment)).toEqual(domainLayout(id, alignment));
  });
});
