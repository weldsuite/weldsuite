import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { SignEnvelopeDetail, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({
  weldsign: { update: vi.fn(), addRecipient: vi.fn(), updateRecipient: vi.fn(), removeRecipient: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('sonner', () => ({ toast }));

import { RecipientsStep } from './recipients-step';

const tr = en.weldsign.editor.recipients;

function recipient(overrides: Partial<SignRecipientDto>): SignRecipientDto {
  return {
    id: 'rcp_ann',
    role: 'signer',
    roleName: null,
    name: 'Ann',
    email: 'ann@example.com',
    personId: null,
    locale: 'en',
    routingOrder: 1,
    authMode: 'link',
    hasAccessCode: false,
    status: 'pending',
    ...overrides,
  } as SignRecipientDto;
}

function draft(recipientList: SignRecipientDto[], overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Agreement',
    status: 'draft',
    signingOrderEnabled: false,
    documents: [],
    recipientList,
    fields: [],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(envelope: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <RecipientsStep envelope={envelope} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.update.mockResolvedValue({ data: draft([]) });
  api.weldsign.updateRecipient.mockResolvedValue({ data: recipient({}) });
  api.weldsign.addRecipient.mockResolvedValue({ data: recipient({}) });
});

afterEach(() => cleanup());

describe('recipients step', () => {
  describe('a draft made from a template', () => {
    const fromTemplate = draft([
      recipient({ id: 'rcp_ann', name: 'Ann', roleName: 'Client' }),
      recipient({ id: 'rcp_bob', name: 'Bob', email: 'bob@example.com', roleName: 'Director', routingOrder: 2 }),
      recipient({ id: 'rcp_cara', name: 'Cara', email: 'cara@example.com', roleName: null, routingOrder: 3 }),
    ]);

    it('shows the role each person fills', () => {
      renderStep(fromTemplate);
      const rows = screen.getAllByRole('listitem');
      expect(within(rows[0]!).getByText('Client')).toBeInTheDocument();
      expect(within(rows[0]!).getByTitle('Role in the template: Client')).toBeInTheDocument();
      expect(within(rows[1]!).getByText('Director')).toBeInTheDocument();
    });

    it('shows no role for someone added by hand', () => {
      renderStep(fromTemplate);
      const rows = screen.getAllByRole('listitem');
      expect(within(rows[2]!).queryByTitle(/^Role in the template/)).toBeNull();
    });

    it('lets the people be changed as in any draft', async () => {
      const user = userEvent.setup();
      renderStep(fromTemplate);
      const name = screen.getByDisplayValue('Ann');
      await user.clear(name);
      await user.type(name, 'Anna');
      await user.tab();
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { name: 'Anna' }));
    });
  });

  describe('an ordinary draft', () => {
    it('shows no role label', () => {
      renderStep(draft([recipient({})]));
      expect(screen.queryByTitle(/^Role in the template/)).toBeNull();
    });

    it('changes the signing order through the request API', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({})]));
      await user.click(screen.getByRole('switch', { name: new RegExp(tr.signingOrder) }));
      await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { signingOrderEnabled: true }));
    });

    it('adds a recipient through the request API', async () => {
      const user = userEvent.setup();
      renderStep(draft([]));
      await user.type(document.getElementById('new-recipient-name')!, 'Dan');
      await user.type(document.getElementById('new-recipient-email')!, 'dan@example.com');
      await user.click(screen.getByRole('button', { name: tr.add }));
      await waitFor(() =>
        expect(api.weldsign.addRecipient).toHaveBeenCalledWith('sgn_1', { name: 'Dan', email: 'dan@example.com', role: 'signer', locale: 'en' }),
      );
    });

    it('swaps the order of two recipients', async () => {
      const user = userEvent.setup();
      renderStep(draft([recipient({}), recipient({ id: 'rcp_bob', name: 'Bob', email: 'bob@example.com', routingOrder: 2 })], { signingOrderEnabled: true }));
      await user.click(screen.getAllByRole('button', { name: en.weldsign.editor.documents.moveDown })[0]!);
      await waitFor(() => expect(api.weldsign.updateRecipient).toHaveBeenCalledTimes(2));
      expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_ann', { routingOrder: 2 });
      expect(api.weldsign.updateRecipient).toHaveBeenCalledWith('sgn_1', 'rcp_bob', { routingOrder: 1 });
    });

    it('is read-only when the draft cannot be changed', () => {
      renderStep(draft([recipient({})]), false);
      expect(screen.getByDisplayValue('Ann')).toBeDisabled();
      expect(screen.getByRole('switch')).toBeDisabled();
      expect(screen.queryByRole('button', { name: tr.add })).toBeNull();
    });
  });
});
