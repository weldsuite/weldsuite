import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { layoutInvoice } from '@weldsuite/books-domain/invoice-template/layout';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import { invoiceTemplateDocumentSchema, type InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';

const env = vi.hoisted(() => ({
  can: true,
  updateMutate: vi.fn(),
  entityMutate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return {
    Link: RouteLink,
    useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: 'idle' }),
  };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.can }));
vi.mock('@/hooks/queries/use-invoice-template-queries', () => ({
  useUpdateInvoiceTemplate: () => ({ mutateAsync: env.updateMutate }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useUpdateAccountingEntity: () => ({ mutateAsync: env.entityMutate }),
}));
vi.mock('./use-image-upload', () => ({
  TEMPLATE_IMAGE_ACCEPT: 'image/png,image/jpeg',
  useTemplateImageUpload: () => async () => 'https://example.com/uploaded.png',
}));
vi.mock('../use-template-preview', async () => {
  const { layoutInvoice: layout } = await import('@weldsuite/books-domain/invoice-template/layout');
  const { useMemo } = await import('react');
  return {
    usePreviewData: () => ({ data: (globalThis as unknown as { __data: unknown }).__data, entity: {} }),
    useTemplateLayout: (doc: Parameters<typeof layout>[0], data: Parameters<typeof layout>[1]) => useMemo(() => layout(doc, data), [doc, data]),
  };
});

import { renderWithProviders, polyfillRadixSelect } from '@/app/weldbooks/invoices/components/test-utils';
import { InvoiceTemplateDesigner } from './designer';

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
(globalThis as unknown as { __data: unknown }).__data = data;

const template = (): InvoiceTemplate => ({
  id: 'itpl_1',
  entityId: 'ent_1',
  name: 'Standard',
  isDefault: false,
  document: presetTemplate('classic', 'a4'),
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
});

const entity = { id: 'ent_1', name: 'Weld BV', baseCurrency: 'EUR', branding: { footerText: 'Thanks' } };

function renderDesigner() {
  return renderWithProviders(<InvoiceTemplateDesigner template={template()} entity={entity as never} />);
}

describe('InvoiceTemplateDesigner', { timeout: 30_000 }, () => {
  beforeAll(() => {
    polyfillRadixSelect();
    if (!('PointerEvent' in window)) {
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: class PointerEvent extends MouseEvent {} });
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
  });
  beforeEach(() => {
    env.can = true;
    env.updateMutate.mockReset().mockResolvedValue({});
    env.entityMutate.mockReset().mockResolvedValue({});
  });
  afterEach(cleanup);

  it('shows the template, its blocks and the document settings', async () => {
    const user = userEvent.setup();
    renderDesigner();
    expect(screen.getByLabelText('Template name')).toHaveValue('Standard');
    // One sidebar: the document inspector first, the palette and the layers (a layer per block) on tabs.
    expect(screen.getByText('Company branding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Blocks' }));
    expect(screen.getByRole('button', { name: 'Add Text' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add Line items' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(screen.getAllByRole('button', { name: /^Reorder|Drag to reorder/ }).length).toBeGreaterThan(5);
  });

  it('adds a block from the palette, selects it, and undo takes it away again', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    const before = container.querySelectorAll('[data-block-id]').length;

    await user.click(screen.getByRole('tab', { name: 'Blocks' }));
    await user.click(screen.getByRole('button', { name: 'Add Rectangle' }));
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(before + 1);
    // The new block is selected: the sidebar drills into it, without the tabs.
    expect(screen.getByText('Position and size')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    // Unsaved changes show as an enabled Save button; there is no separate label.
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    // Back returns to the tab you were on.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('tab', { name: 'Blocks' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Add Rectangle' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(before);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('edits the selected block in the inspector', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    fireEvent.pointerDown(container.querySelector('[data-block-id="footer"]')!, { button: 0, clientX: 60, clientY: 800, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    const textarea = await screen.findByDisplayValue('{{footerText}}');
    await user.clear(textarea);
    await user.type(textarea, 'Pay soon');
    expect(textarea).toHaveValue('Pay soon');

    const x = screen.getByLabelText('X');
    await user.clear(x);
    await user.type(x, '72');
    expect(x).toHaveValue('72');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('validates and saves only what changed', async () => {
    const user = userEvent.setup();
    renderDesigner();
    await user.click(screen.getByRole('tab', { name: 'Blocks' }));
    await user.click(screen.getByRole('button', { name: 'Add Text' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    const { id, data: sent } = env.updateMutate.mock.calls[0][0];
    expect(id).toBe('itpl_1');
    expect(Object.keys(sent)).toEqual(['document']);
    expect(invoiceTemplateDocumentSchema.safeParse(sent.document).success).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('saves a new name without resending the page', async () => {
    const user = userEvent.setup();
    renderDesigner();
    const name = screen.getByLabelText('Template name');
    await user.clear(name);
    await user.type(name, 'Letterhead');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    expect(env.updateMutate.mock.calls[0][0].data).toEqual({ name: 'Letterhead' });
    // The default template is chosen on the templates list; the designer has no switch for it.
    expect(screen.queryByRole('switch', { name: 'Default' })).toBeNull();
  });

  it('works from the keyboard: nudge, duplicate, delete, undo', async () => {
    const { container } = renderDesigner();
    const count = () => container.querySelectorAll('[data-block-id]').length;
    const start = count();
    fireEvent.pointerDown(container.querySelector('[data-block-id="logo"]')!, { button: 0, clientX: 80, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true });
    expect(count()).toBe(start + 1);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(count()).toBe(start);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(count()).toBe(start + 1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText('Company branding')).toBeInTheDocument();
  });

  it('never deletes the line-items table', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    const start = container.querySelectorAll('[data-block-id]').length;
    fireEvent.pointerDown(container.querySelector('[data-block-id="items"]')!, { button: 0, clientX: 80, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(start);
    // The block's ⋯ menu has Delete switched off, and says why.
    await user.click(screen.getByRole('button', { name: 'Block actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('The line-items table cannot be removed: every invoice needs one.')).toBeInTheDocument();
  });

  it('duplicates and deletes a block from its ⋯ menu', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    const count = () => container.querySelectorAll('[data-block-id]').length;
    const start = count();
    fireEvent.pointerDown(container.querySelector('[data-block-id="logo"]')!, { button: 0, clientX: 80, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    await user.click(screen.getByRole('button', { name: 'Block actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(count()).toBe(start + 1);

    await user.click(screen.getByRole('button', { name: 'Block actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(count()).toBe(start);
  });

  it('is read-only without permission: no adding, no saving', async () => {
    const user = userEvent.setup();
    env.can = false;
    renderDesigner();
    await user.click(screen.getByRole('tab', { name: 'Blocks' }));
    expect(screen.getByRole('button', { name: 'Add Text' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('Template name')).toBeDisabled();
    expect(screen.getByText(/changing it needs permission/i)).toBeInTheDocument();
  });

  it('zooms with the corner controls and the keyboard, and stops at the limits', async () => {
    const user = userEvent.setup();
    renderDesigner();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });

    // 100% to 200% in steps of 1.2: four presses, then the button is done.
    for (let i = 0; i < 4; i += 1) await user.click(zoomIn);
    expect(zoomIn).toBeDisabled();
    expect(zoomOut).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(zoomIn).toBeEnabled();

    // Down to 50% from the keyboard; Cmd/Ctrl+0 fits again.
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(document.body, { key: '-', ctrlKey: true });
    expect(zoomOut).toBeDisabled();
    fireEvent.keyDown(document.body, { key: '0', ctrlKey: true });
    expect(zoomOut).toBeEnabled();
    fireEvent.keyDown(document.body, { key: '=', ctrlKey: true });
    expect(zoomIn).toBeEnabled();
    expect(zoomOut).toBeEnabled();
  });

  it('previews the mobile layout, where a click selects the block it comes from', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    await user.click(screen.getByRole('combobox', { name: 'View' }));
    await user.click(await screen.findByRole('option', { name: 'Mobile' }));

    const phone = screen.getByTestId('mobile-preview');
    expect(container.querySelector('[data-canvas-page]')).toBeNull();
    expect(phone).toHaveTextContent('Acme Industries');

    const items = phone.querySelector<HTMLElement>('[data-block-id="items"]')!;
    await user.click(items);
    expect(screen.getByText('Position and size')).toBeInTheDocument();
    await user.click(phone);
    expect(screen.getByText('Company branding')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'View' }));
    await user.click(await screen.findByRole('option', { name: 'Desktop' }));
    expect(container.querySelector('[data-canvas-page]')).not.toBeNull();
  });

  it('finds blocks by name in the palette', async () => {
    const user = userEvent.setup();
    renderDesigner();
    await user.click(screen.getByRole('tab', { name: 'Blocks' }));
    await user.type(screen.getByRole('textbox', { name: 'Search blocks' }), 'bill');
    expect(screen.getByRole('button', { name: 'Add Bill to' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Text' })).toBeNull();
    expect(screen.queryByText('Content')).toBeNull();

    await user.clear(screen.getByRole('textbox', { name: 'Search blocks' }));
    await user.type(screen.getByRole('textbox', { name: 'Search blocks' }), 'zebra');
    expect(screen.getByText('No blocks match “zebra”.')).toBeInTheDocument();
  });

  it('finds layers by name, shows placeholders as field names, and pauses reordering while filtered', async () => {
    const user = userEvent.setup();
    renderDesigner();
    await user.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(screen.getAllByRole('button', { name: /^Drag to reorder/ }).length).toBeGreaterThan(5);

    await user.type(screen.getByRole('textbox', { name: 'Search layers' }), 'date');
    expect(screen.getByRole('button', { name: 'Hide: Issue date' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide: Bill to' })).toBeNull();
    for (const handle of screen.getAllByRole('button', { name: /^Drag to reorder/ })) expect(handle).toBeDisabled();

    await user.clear(screen.getByRole('textbox', { name: 'Search layers' }));
    await user.type(screen.getByRole('textbox', { name: 'Search layers' }), 'zebra');
    expect(screen.getByText('No layers match “zebra”.')).toBeInTheDocument();
  });

  it('lays out the sample the engine reports on', () => {
    // Sanity check of the fixture the tests above rely on.
    expect(layoutInvoice(presetTemplate('classic', 'a4'), data).pages).toHaveLength(1);
  });
});
