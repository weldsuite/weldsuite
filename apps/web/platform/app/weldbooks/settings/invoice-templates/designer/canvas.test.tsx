import { useMemo, useReducer, createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { layoutInvoice } from '@weldsuite/books-domain/invoice-template/layout';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import type { InvoiceTemplateDocument } from '@weldsuite/books-domain/invoice-template/schema';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { DesignerCanvas, type CanvasApi } from './canvas';
import { editorReducer, initialEditorState } from './model/editor-reducer';

const data: InvoiceDocumentData = {
  fields: { title: 'Invoice', invoiceNumber: 'INV-0042', issueDate: '1 October 2026', dueDate: '31 October 2026' },
  fieldLabels: { invoiceNumber: 'Invoice number', issueDate: 'Issue date', dueDate: 'Due date' },
  labels: { from: 'From', billTo: 'Bill to', shipTo: 'Ship to', payment: 'Payment', notes: 'Notes', terms: 'Terms', page: 'Page {page} of {total}' },
  seller: { name: 'Weld BV', lines: ['Keizersgracht 1'] },
  billTo: { name: 'Acme Industries', lines: ['Main Street 5'] },
  table: {
    columns: { description: { label: 'Description' }, quantity: { label: 'Qty' }, unitPrice: { label: 'Unit price' }, taxRate: { label: 'VAT' }, amount: { label: 'Amount' } },
    rows: [{ cells: { description: 'Consulting', quantity: '1', unitPrice: '100', taxRate: '21%', amount: '100' } }],
  },
  totals: [{ label: 'Total', value: '121', kind: 'total' }],
  payment: { bankLines: [] },
  legal: { notices: [] },
};

interface Snapshot {
  selection: string[];
  past: number;
  blocks: Record<string, { x: number; y: number; w: number; h: number }>;
}

function Harness({ initial, readOnly = false }: Readonly<{ initial: InvoiceTemplateDocument; readOnly?: boolean }>) {
  const [state, dispatch] = useReducer(editorReducer, initial, initialEditorState);
  const layout = useMemo(() => layoutInvoice(state.doc, data), [state.doc]);
  const api = useMemo(() => createRef<CanvasApi | null>(), []);
  const snapshot: Snapshot = {
    selection: state.selection,
    past: state.past.length,
    blocks: Object.fromEntries(state.doc.blocks.map((b) => [b.id, { x: b.x, y: b.y, w: b.w, h: b.h }])),
  };
  return (
    <TooltipProvider>
      <DesignerCanvas
        doc={state.doc}
        layout={layout}
        selection={state.selection}
        scale={1}
        readOnly={readOnly}
        dispatch={dispatch}
        apiRef={api}
        onDropBlock={vi.fn()}
        onWheelZoom={vi.fn()}
      />
      <output data-testid="state">{JSON.stringify(snapshot)}</output>
    </TooltipProvider>
  );
}

const read = (): Snapshot => JSON.parse(screen.getByTestId('state').textContent ?? '{}');
const box = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;

function drag(el: Element, from: { x: number; y: number }, to: { x: number; y: number }, init: PointerEventInit = {}) {
  fireEvent.pointerDown(el, { button: 0, clientX: from.x, clientY: from.y, pointerId: 1, ...init });
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1, ...init });
  fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y, pointerId: 1, ...init });
}

describe('DesignerCanvas', () => {
  beforeAll(() => {
    // jsdom has no PointerEvent: a mouse event carries the same coordinates, button and modifiers.
    if (!('PointerEvent' in window)) {
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: class PointerEvent extends MouseEvent {} });
    }
    // jsdom lays nothing out: pretend the scroll area is big, so a press is not mistaken for one on its scrollbar.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 2000 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 2000 });
  });
  afterEach(cleanup);

  const initial = () => presetTemplate('classic', 'a4');

  it('draws the page and one interaction box per block', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(initial().blocks.length);
  });

  it('selects on click and extends the selection with shift', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    fireEvent.pointerDown(box(container, 'title'), { button: 0, clientX: 300, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(read().selection).toEqual(['title']);

    fireEvent.pointerDown(box(container, 'number'), { button: 0, shiftKey: true, clientX: 300, clientY: 80, pointerId: 1 });
    expect(read().selection.sort()).toEqual(['number', 'title']);
  });

  it('moves a block with the pointer, snapped to the grid, as one history entry', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    const before = read().blocks.logo;
    drag(box(container, 'logo'), { x: 100, y: 60 }, { x: 131, y: 83 });
    const after = read();
    expect(after.blocks.logo.x - before.x).toBeGreaterThanOrEqual(28);
    expect(after.blocks.logo.x - before.x).toBeLessThanOrEqual(34);
    expect(after.blocks.logo.y).not.toBe(before.y);
    expect(after.blocks.logo.w).toBe(before.w);
    expect(after.past).toBe(1);
  });

  it('moves without snapping while Alt is held', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    const before = read().blocks.logo;
    drag(box(container, 'logo'), { x: 100, y: 60 }, { x: 113, y: 67 }, { altKey: true });
    const after = read().blocks.logo;
    expect(after.x).toBeCloseTo(before.x + 13, 5);
    expect(after.y).toBeCloseTo(before.y + 7, 5);
  });

  it('does not move a click that never travelled', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    drag(box(container, 'logo'), { x: 100, y: 60 }, { x: 101, y: 61 });
    expect(read().past).toBe(0);
  });

  it('does not move a locked block, but still selects it', () => {
    const doc = initial();
    doc.blocks = doc.blocks.map((b) => (b.id === 'logo' ? { ...b, locked: true } : b));
    const { container } = renderWithProviders(<Harness initial={doc} />);
    const before = read().blocks.logo;
    drag(box(container, 'logo'), { x: 100, y: 60 }, { x: 160, y: 120 });
    expect(read().blocks.logo).toEqual(before);
    expect(read().selection).toEqual(['logo']);
  });

  it('does not move anything when read-only', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} readOnly />);
    const before = read().blocks.logo;
    drag(box(container, 'logo'), { x: 100, y: 60 }, { x: 160, y: 120 });
    expect(read().blocks.logo).toEqual(before);
  });

  it('resizes from a corner handle', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    fireEvent.pointerDown(box(container, 'logo'), { button: 0, clientX: 100, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    const before = read().blocks.logo;
    const handle = container.querySelector<HTMLElement>('[data-handle="se"]')!;
    drag(handle, { x: 208, y: 92 }, { x: 228, y: 102 }, { altKey: true });
    const after = read().blocks.logo;
    expect(after.x).toBe(before.x);
    expect(after.w).toBeCloseTo(before.w + 20, 5);
    expect(after.h).toBeCloseTo(before.h + 10, 5);
  });

  it('selects the blocks a marquee touches', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    const backdrop = container.firstElementChild as HTMLElement;
    // The logo sits at 48,44 (160 x 48); start the marquee on empty canvas beside the page's top-left.
    drag(backdrop, { x: 0, y: 0 }, { x: 120, y: 80 });
    expect(read().selection).toContain('logo');
    expect(read().selection).not.toContain('items');
  });

  it('clears the selection when empty canvas is clicked', () => {
    const { container } = renderWithProviders(<Harness initial={initial()} />);
    fireEvent.pointerDown(box(container, 'logo'), { button: 0, clientX: 100, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(read().selection).toEqual(['logo']);
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(backdrop, { button: 0, clientX: 590, clientY: 830, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(read().selection).toEqual([]);
  });
});
