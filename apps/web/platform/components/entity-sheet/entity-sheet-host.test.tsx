import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  target: null as { type: string; id: string } | null,
  close: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('./use-entity-sheet', () => ({
  useEntitySheet: () => ({ target: h.target, view: 'default', close: h.close, toggleView: vi.fn() }),
}));
// The default registry pulls every renderer (and their panels) into the module graph.
vi.mock('./registry', async () => ({
  DEFAULT_ENTITY_SHEET_REGISTRY: {},
  pageHrefForEntity: (await import('./registry-meta')).pageHrefForEntity,
}));

import { EntitySheetHost } from './entity-sheet-host';

describe('EntitySheetHost · a type without an entity sheet', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('sends ?entity=sheet:<id> to the spreadsheet page instead of opening a sheet', () => {
    h.target = { type: 'sheet', id: 'sht_1' };
    const { container } = render(<EntitySheetHost />);

    expect(container.firstChild).toBeNull();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith('/weldsheets/sht_1');
  });

  it('just closes a type that has neither a sheet nor a page', () => {
    h.target = { type: 'contact', id: 'per_1' };
    render(<EntitySheetHost />);

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
  });
});
