import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  openEntitySheet: vi.fn(),
  title: { status: 'ok', title: 'Budget 2026' } as { status: string; title: string | null },
}));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/components/entity-sheet/use-entity-sheet', () => ({
  useEntitySheet: () => ({ open: h.openEntitySheet }),
}));
vi.mock('@/components/entity-sheet/skip-animation', () => ({ flagSkipNextEntitySheetAnimation: vi.fn() }));
vi.mock('../hooks/use-entity-title', () => ({ useEntityTitle: () => h.title }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/workspace-url-rewrite', () => ({ toPublicPath: (path: string) => path }));

import { EntityMentionChip } from './entity-mention-chip';

describe('EntityMentionChip', () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);

  beforeEach(() => {
    h.title = { status: 'ok', title: 'Budget 2026' };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('a record with a page but no entity sheet (a spreadsheet)', () => {
    it('is a chip with the live name', () => {
      const { getByRole } = render(<EntityMentionChip type="sheet" id="sht_1" fallbackLabel="Budget" />);
      expect(getByRole('button').textContent).toBe('@Budget 2026');
    });

    it('opens the page in the app on a plain click', () => {
      const { getByRole } = render(<EntityMentionChip type="sheet" id="sht_1" fallbackLabel="Budget" />);
      fireEvent.click(getByRole('button'));

      expect(h.push).toHaveBeenCalledWith('/weldsheets/sht_1');
      expect(h.openEntitySheet).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it.each([
      ['cmd', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['shift', { shiftKey: true }],
    ])('opens the page in a new tab on %s+click', (_label, modifier) => {
      const { getByRole } = render(<EntityMentionChip type="sheet" id="sht_1" fallbackLabel="Budget" />);
      const chip = getByRole('button');
      fireEvent.mouseDown(chip, modifier);
      fireEvent.click(chip);

      expect(open).toHaveBeenCalledWith('/weldsheets/sht_1', '_blank', 'noopener');
      expect(h.push).not.toHaveBeenCalled();
    });

    it('falls back to the label baked into the message while the name loads', () => {
      h.title = { status: 'loading', title: null };
      const { getByRole } = render(<EntityMentionChip type="sheet" id="sht_1" fallbackLabel="Budget" />);
      expect(getByRole('button').textContent).toBe('@Budget');
    });

    it('is not clickable once the sheet is gone or private', () => {
      h.title = { status: 'notfound', title: null };
      const { queryByRole, container } = render(<EntityMentionChip type="sheet" id="sht_1" fallbackLabel="Budget" />);
      expect(queryByRole('button')).toBeNull();
      expect(container.textContent).toBe('@Budget');
    });
  });

  describe('every other type keeps its behaviour', () => {
    it('opens a record with an entity sheet in the sheet, not on its page', () => {
      const { getByRole } = render(<EntityMentionChip type="ticket" id="tkt_1" fallbackLabel="Broken pump" />);
      fireEvent.click(getByRole('button'));

      expect(h.openEntitySheet).toHaveBeenCalledWith('ticket', 'tkt_1');
      expect(h.push).not.toHaveBeenCalled();
    });

    it('still opens a project (sheet and page) in a new tab on a modified click', () => {
      const { getByRole } = render(<EntityMentionChip type="project" id="prj_1" fallbackLabel="Launch" />);
      const chip = getByRole('button');
      fireEvent.mouseDown(chip, { ctrlKey: true });
      fireEvent.click(chip);

      expect(open).toHaveBeenCalledWith('/weldflow/project/prj_1', '_blank', 'noopener');
      expect(h.openEntitySheet).not.toHaveBeenCalled();
    });

    it('opens a lead, which has no page, in its sheet even on a modified click', () => {
      const { getByRole } = render(<EntityMentionChip type="lead" id="lead_1" fallbackLabel="Acme" />);
      const chip = getByRole('button');
      fireEvent.mouseDown(chip, { ctrlKey: true });
      fireEvent.click(chip);

      expect(open).not.toHaveBeenCalled();
      expect(h.openEntitySheet).toHaveBeenCalledWith('lead', 'lead_1');
    });

    it.each(['contact', 'customer', 'product', 'order'] as const)(
      'shows a %s, which has neither a sheet nor a page, as plain text',
      (type) => {
        const { queryByRole, container } = render(<EntityMentionChip type={type} id="x_1" fallbackLabel="Jane" />);
        expect(queryByRole('button')).toBeNull();
        expect(container.textContent).toBe('@Jane');
      },
    );
  });
});
