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

  it('shows the template, its blocks and the document settings', () => {
    renderDesigner();
    expect(screen.getByLabelText('Template name')).toHaveValue('Standard');
    // Palette, layers (a layer per block) and the document inspector.
    expect(screen.getByRole('button', { name: 'Add Text' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add Line items' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /^Reorder|Drag to reorder/ }).length).toBeGreaterThan(5);
    expect(screen.getByText('Company branding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('adds a block from the palette, selects it, and undo takes it away again', async () => {
    const user = userEvent.setup();
    const { container } = renderDesigner();
    const before = container.querySelectorAll('[data-block-id]').length;

    await user.click(screen.getByRole('button', { name: 'Add Rectangle' }));
    expect(container.querySelectorAll('[data-block-id]').length).toBe(before + 1);
    expect(screen.getByText('Position and size')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(container.querySelectorAll('[data-block-id]').length).toBe(before);
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
    await user.click(screen.getByRole('button', { name: 'Add Text' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    const { id, data: sent } = env.updateMutate.mock.calls[0][0];
    expect(id).toBe('itpl_1');
    expect(Object.keys(sent)).toEqual(['document']);
    expect(invoiceTemplateDocumentSchema.safeParse(sent.document).success).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('saves a new name and the default flag without resending the page', async () => {
    const user = userEvent.setup();
    renderDesigner();
    const name = screen.getByLabelText('Template name');
    await user.clear(name);
    await user.type(name, 'Letterhead');
    await user.click(screen.getByRole('switch', { name: 'Default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    expect(env.updateMutate.mock.calls[0][0].data).toEqual({ name: 'Letterhead', isDefault: true });
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

  it('never deletes the line-items table', () => {
    const { container } = renderDesigner();
    const start = container.querySelectorAll('[data-block-id]').length;
    fireEvent.pointerDown(container.querySelector('[data-block-id="items"]')!, { button: 0, clientX: 80, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(container.querySelectorAll('[data-block-id]').length).toBe(start);
    // The inspector explains why, on the disabled button.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('is read-only without permission: no adding, no saving', () => {
    env.can = false;
    renderDesigner();
    expect(screen.getByRole('button', { name: 'Add Text' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('Template name')).toBeDisabled();
    expect(screen.getByText(/changing it needs permission/i)).toBeInTheDocument();
  });

  it('lays out the sample the engine reports on', () => {
    // Sanity check of the fixture the tests above rely on.
    expect(layoutInvoice(presetTemplate('classic', 'a4'), data).pages).toHaveLength(1);
  });
});
