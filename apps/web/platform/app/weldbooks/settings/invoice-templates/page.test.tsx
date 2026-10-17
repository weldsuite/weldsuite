import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import { invoiceTemplateDocumentSchema, type InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';

const env = vi.hoisted(() => ({
  can: true,
  loading: false,
  templates: [] as InvoiceTemplate[],
  push: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  jurisdiction: 'NL',
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.can }));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentAccountingEntityRow: () => ({ entity: { id: 'ent_1', baseCurrency: 'EUR', jurisdictionCode: env.jurisdiction }, entities: [] }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: () => ({
    data: { id: 'ent_1', name: 'Weld BV', jurisdictionCode: env.jurisdiction, branding: { accentColor: '#0f766e' } },
  }),
}));
vi.mock('@/hooks/queries/use-invoice-template-queries', () => ({
  useInvoiceTemplates: () => ({ data: env.templates, isLoading: env.loading, isError: false, refetch: vi.fn() }),
  useCreateInvoiceTemplate: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdateInvoiceTemplate: () => ({ mutateAsync: env.update, isPending: false }),
  useDuplicateInvoiceTemplate: () => ({ mutateAsync: env.duplicate, isPending: false }),
  useDeleteInvoiceTemplate: () => ({ mutateAsync: env.remove, isPending: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string) => `on ${value.slice(0, 10)}` }),
}));
vi.mock('./use-template-preview', async () => {
  const { layoutInvoice } = await import('@weldsuite/books-domain/invoice-template/layout');
  const { useMemo } = await import('react');
  return {
    usePreviewData: () => ({ data: (globalThis as unknown as { __data: unknown }).__data, entity: {} }),
    useTemplateLayout: (doc: Parameters<typeof layoutInvoice>[0], data: Parameters<typeof layoutInvoice>[1]) =>
      useMemo(() => layoutInvoice(doc, data), [doc, data]),
  };
});

import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import InvoiceTemplatesPage from './page';

(globalThis as unknown as { __data: InvoiceDocumentData }).__data = {
  fields: { title: 'Invoice', invoiceNumber: 'INV-0042' },
  fieldLabels: { invoiceNumber: 'Invoice number' },
  labels: { from: 'From', billTo: 'Bill to', shipTo: 'Ship to', payment: 'Payment', notes: 'Notes', terms: 'Terms', page: 'Page {page} of {total}' },
  seller: { name: 'Weld BV', lines: [] },
  billTo: { name: 'Acme', lines: [] },
  table: { columns: { description: { label: 'Description' }, amount: { label: 'Amount' } }, rows: [{ cells: { description: 'Work', amount: '1' } }] },
  totals: [{ label: 'Total', value: '1', kind: 'total' }],
  payment: { bankLines: [] },
  legal: { notices: [] },
};

const template = (id: string, name: string, isDefault: boolean): InvoiceTemplate => ({
  id,
  entityId: 'ent_1',
  name,
  isDefault,
  document: presetTemplate('classic', 'a4'),
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-02T10:00:00Z',
});

describe('InvoiceTemplatesPage', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.can = true;
    env.loading = false;
    env.jurisdiction = 'NL';
    env.templates = [];
    env.push.mockReset();
    env.create.mockReset().mockResolvedValue({ id: 'itpl_new' });
    env.update.mockReset().mockResolvedValue({});
    env.duplicate.mockReset().mockResolvedValue({});
    env.remove.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('explains the built-in layout when there are no templates, and offers a first one', () => {
    renderWithProviders(<InvoiceTemplatesPage />);
    expect(screen.getByText('No templates yet')).toBeInTheDocument();
    expect(screen.getByText(/invoices print with the built-in layout/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create your first template' })).toBeInTheDocument();
  });

  it('shows the standard list loading state while loading', () => {
    env.loading = true;
    renderWithProviders(<InvoiceTemplatesPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Standard' })).not.toBeInTheDocument();
  });

  it('finds templates with the list search', async () => {
    const user = userEvent.setup();
    env.templates = [template('itpl_1', 'Standard', true), template('itpl_2', 'Letterhead', false)];
    renderWithProviders(<InvoiceTemplatesPage />);
    await user.type(screen.getAllByPlaceholderText('Search templates')[0], 'letter');
    expect(screen.getByRole('heading', { name: 'Letterhead' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Standard' })).not.toBeInTheDocument();
  });

  it('lists the templates with a thumbnail, the default badge, the paper size and a link to the designer', () => {
    env.templates = [template('itpl_1', 'Standard', true), template('itpl_2', 'Letterhead', false)];
    renderWithProviders(<InvoiceTemplatesPage />);

    expect(screen.getByRole('heading', { name: 'Standard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Letterhead' })).toBeInTheDocument();
    // Only the default template carries the star.
    expect(screen.getAllByLabelText('Default')).toHaveLength(1);
    expect(screen.queryByText('Default')).toBeNull();
    expect(screen.getAllByText(/A4 · Updated on 2026-03-02/)).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Preview of Standard' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Edit: Letterhead' })).toHaveAttribute('href', '/weldbooks/settings/invoice-templates/itpl_2');
  });

  it('sets another template as default, duplicates, and deletes after a confirmation that names the fallback', async () => {
    const user = userEvent.setup();
    env.templates = [template('itpl_1', 'Standard', true), template('itpl_2', 'Letterhead', false)];
    renderWithProviders(<InvoiceTemplatesPage />);

    await user.click(screen.getByRole('button', { name: 'Template actions: Letterhead' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set as default' }));
    expect(env.update).toHaveBeenCalledWith({ id: 'itpl_2', data: { isDefault: true } });

    await user.click(screen.getByRole('button', { name: 'Template actions: Letterhead' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(env.duplicate).toHaveBeenCalledWith('itpl_2');

    await user.click(screen.getByRole('button', { name: 'Template actions: Letterhead' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/fall back to the default template/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith('itpl_2'));
  });

  it('warns that deleting the default leaves invoices on the built-in layout', async () => {
    const user = userEvent.setup();
    env.templates = [template('itpl_1', 'Standard', true)];
    renderWithProviders(<InvoiceTemplatesPage />);

    await user.click(screen.getByRole('button', { name: 'Template actions: Standard' }));
    expect(screen.queryByRole('menuitem', { name: 'Set as default' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByText(/invoices print with the built-in layout\. This cannot be undone/)).toBeInTheDocument();
  });

  it('creates a template from a preset with the company accent and opens it in the designer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceTemplatesPage />);

    await user.click(screen.getByRole('button', { name: 'Create your first template' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create and design' }));
    expect(await within(dialog).findByText('Give the template a name.')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/^Name/), 'Standard invoice');
    await user.click(within(dialog).getByRole('radio', { name: /Modern/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create and design' }));

    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const input = env.create.mock.calls[0][0];
    expect(input).toMatchObject({ entityId: 'ent_1', name: 'Standard invoice' });
    expect(input.document.paperSize).toBe('a4');
    expect(input.document.theme.accent).toBe('#0f766e');
    expect(invoiceTemplateDocumentSchema.safeParse(input.document).success).toBe(true);
    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/settings/invoice-templates/itpl_new'));
  });

  it('starts a US company on Letter paper', async () => {
    const user = userEvent.setup();
    env.jurisdiction = 'US';
    renderWithProviders(<InvoiceTemplatesPage />);

    await user.click(screen.getByRole('button', { name: 'Create your first template' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'US invoice');
    await user.click(within(dialog).getByRole('button', { name: 'Create and design' }));
    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    expect(env.create.mock.calls[0][0].document.paperSize).toBe('letter');
  });

  it('hides the write actions from someone who can only read', () => {
    env.can = false;
    env.templates = [template('itpl_1', 'Standard', true)];
    renderWithProviders(<InvoiceTemplatesPage />);
    expect(screen.queryByRole('button', { name: 'New template' })).not.toBeInTheDocument();
    expect(screen.getByText(/changing them needs permission/)).toBeInTheDocument();
  });
});
