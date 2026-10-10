import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { FileListView, type FileListItem } from './file-list-view';

const ITEMS: FileListItem[] = [
  {
    id: 'f1',
    name: 'qa-contract-final.pdf',
    fileType: 'pdf',
    source: 'drive',
    fileSize: 19 * 1024,
    createdAt: '2026-10-09T10:00:00.000Z',
  },
];

// jsdom has no layout: report the list's width ourselves, to both the initial
// `clientWidth` read and the ResizeObserver callback.
let boxWidth = 0;
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback([{ contentRect: { width: boxWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => boxWidth);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderList() {
  return render(
    <I18nProvider initialLanguage="en">
      <FileListView
        items={ITEMS}
        onRowClick={() => {}}
        renderRowMenu={() => <DropdownMenuItem>Delete</DropdownMenuItem>}
      />
    </I18nProvider>,
  );
}

describe('FileListView', () => {
  it('uses the compact two-line row in a narrow panel: no column header, size and date as secondary text, a visible menu', () => {
    boxWidth = 400;
    renderList();

    expect(screen.getByText('qa-contract-final.pdf')).toBeInTheDocument();
    // Size and modified date read as one secondary line instead of wrapping in their own columns.
    expect(screen.getByText(/19 KB · /)).toBeInTheDocument();
    // The table's column headers are gone...
    expect(screen.queryByText('Modified')).not.toBeInTheDocument();
    expect(screen.queryByText('Size')).not.toBeInTheDocument();
    // ...and the row actions are reachable without hovering.
    const menu = screen.getByRole('button', { name: 'More actions' });
    expect(menu.parentElement).not.toHaveClass('opacity-0');
  });

  it('keeps the full table with its column headers and hover-revealed menu when there is room', () => {
    boxWidth = 900;
    renderList();

    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' }).parentElement).toHaveClass('opacity-0');
  });
});
