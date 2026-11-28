import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  canEdit: true,
  toast: { success: vi.fn(), error: vi.fn() },
  salesApi: { getEmailTemplates: vi.fn(), updateEmailTemplates: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canEdit }));
vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: env.salesApi,
}));

import { EmailTemplatesCard } from './email-templates-card';
import { polyfillRadixSelect, renderWithProviders } from '../../invoices/components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const PLACEHOLDERS = ['customerName', 'number', 'amount', 'dueDate', 'link', 'companyName', 'collectionCosts', 'interest', 'totalClaim', 'noticeDays'];

const settings = () => ({
  data: {
    entityId: 'ent_1',
    kinds: ['invoice', 'quote', 'reminder1', 'reminder2', 'reminder3', 'creditNote'],
    locales: ['nl', 'en'],
    placeholders: PLACEHOLDERS,
    templates: {
      invoice: {
        nl: { subject: 'Factuur {number} van {companyName}', body: 'Beste {customerName},\n\nBetaal {amount} voor {dueDate}.', isDefault: true },
        en: { subject: 'Invoice {number}', body: 'Dear {customerName}', isDefault: false },
      },
      reminder3: {
        nl: { subject: 'Laatste aanmaning {number}', body: 'Totaal: {totalClaim}', isDefault: true },
        en: { subject: 'Final notice {number}', body: 'Total: {totalClaim}', isDefault: true },
      },
    },
  },
});

describe('EmailTemplatesCard', () => {
  beforeEach(() => {
    polyfillRadixSelect();
    setRuntimeConfig(RUST);
    env.canEdit = true;
    env.salesApi.getEmailTemplates.mockReset();
    env.salesApi.updateEmailTemplates.mockReset();
    env.salesApi.getEmailTemplates.mockResolvedValue(settings());
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  async function renderCard() {
    const utils = renderWithProviders(<EmailTemplatesCard />);
    await screen.findByLabelText('Subject');
    return utils;
  }

  it('opens on the invoice text in Dutch, and says it is WeldSuite’s own', async () => {
    await renderCard();
    expect(screen.getByLabelText('Subject')).toHaveValue('Factuur {number} van {companyName}');
    expect(screen.getByLabelText('Message')).toHaveValue('Beste {customerName},\n\nBetaal {amount} voor {dueDate}.');
    expect(screen.getByText('WeldSuite’s text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dutch' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the text with sample values in a preview', async () => {
    await renderCard();
    const preview = screen.getByTestId('template-preview');
    expect(preview).toHaveTextContent('Factuur F-2026-0042 van Acme B.V.');
    expect(preview).toHaveTextContent('Beste Jansen Bouw B.V.,');
    expect(preview).toHaveTextContent('Betaal € 1.210,00 voor 12-12-2026.');
  });

  it('inserts a placeholder at the cursor when its chip is clicked', async () => {
    const user = userEvent.setup();
    await renderCard();
    const body = screen.getByLabelText('Message') as HTMLTextAreaElement;
    body.focus();
    body.setSelectionRange(0, 0);
    await user.click(screen.getAllByRole('button', { name: 'Insert Online link' })[1]);
    expect(body.value.startsWith('{link}Beste')).toBe(true);
    expect(screen.getByTestId('template-preview')).toHaveTextContent('https://pay.example.test/d/abc123Beste');
  });

  it('offers the statutory placeholders only to a reminder', async () => {
    const user = userEvent.setup();
    await renderCard();
    expect(screen.queryByRole('button', { name: 'Insert Collection costs' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Which e-mail' }));
    await user.click(await screen.findByRole('option', { name: 'Reminder 3' }));
    expect(screen.getAllByRole('button', { name: 'Insert Total to pay' })).toHaveLength(2);
    expect(screen.getByLabelText('Subject')).toHaveValue('Laatste aanmaning {number}');
  });

  it('switches language and keeps what was typed for the other one', async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.type(screen.getByLabelText('Subject'), '!');
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByLabelText('Subject')).toHaveValue('Invoice {number}');
    await user.click(screen.getByRole('button', { name: 'Dutch' }));
    expect(screen.getByLabelText('Subject')).toHaveValue('Factuur {number} van {companyName}!');
  });

  it('saves a changed text for that kind and language only', async () => {
    const user = userEvent.setup();
    env.salesApi.updateEmailTemplates.mockResolvedValue(settings());
    await renderCard();
    const save = screen.getByRole('button', { name: 'Save text' });
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Subject'));
    // `{` starts a key in `type`; the text is pasted instead.
    await user.click(screen.getByLabelText('Subject'));
    await user.paste('Nieuw {number}');
    await user.click(save);
    await waitFor(() =>
      expect(env.salesApi.updateEmailTemplates).toHaveBeenCalledWith({
        invoice: { nl: { subject: 'Nieuw {number}', body: 'Beste {customerName},\n\nBetaal {amount} voor {dueDate}.' } },
      }),
    );
    expect(env.toast.success).toHaveBeenCalledWith('E-mail text saved');
  });

  it('does not save an empty text', async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.clear(screen.getByLabelText('Subject'));
    expect(screen.getByRole('button', { name: 'Save text' })).toBeDisabled();
  });

  it('resets a text to the default with null, and has nothing to reset on the default', async () => {
    const user = userEvent.setup();
    env.salesApi.updateEmailTemplates.mockResolvedValue(settings());
    await renderCard();
    // Dutch is already WeldSuite's text.
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(env.salesApi.updateEmailTemplates).toHaveBeenCalledWith({ invoice: { en: null } }));
    expect(env.toast.success).toHaveBeenCalledWith('The text is back to WeldSuite’s default');
  });

  it('warns about a placeholder the server does not know, which would be sent as written', async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByLabelText('Message'));
    await user.paste(' {nonsense}');
    expect(screen.getByRole('alert')).toHaveTextContent('These are not known and are sent as written: {nonsense}');
  });

  it('is read only for a member who may not change accounting settings', async () => {
    env.canEdit = false;
    await renderCard();
    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save text' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('email-templates-card')).queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();
  });

  it('says so when the texts cannot be loaded, and tries again', async () => {
    const user = userEvent.setup();
    env.salesApi.getEmailTemplates.mockRejectedValueOnce(new Error('down'));
    renderWithProviders(<EmailTemplatesCard />);
    expect(await screen.findByText('The e-mail texts could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByLabelText('Subject')).toBeInTheDocument();
  });
});
