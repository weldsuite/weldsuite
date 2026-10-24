import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import { ApiError } from '@weldsuite/api-client';
import type { SignEnvelopeDetail, SignFieldDto, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const api = vi.hoisted(() => ({ weldsign: { update: vi.fn(), send: vi.fn() } }));
const state = vi.hoisted(() => ({ permissions: new Set<string>(['sign_envelopes:send']) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => state.permissions.has(permission) }));
vi.mock('sonner', () => ({ toast }));

import { ReviewStep } from './review-step';

const tr = en.weldsign.editor.review;

const ann = { id: 'rcp_ann', role: 'signer', roleName: null, name: 'Ann', email: 'ann@example.com' } as SignRecipientDto;
const signature = { id: 'f_1', recipientId: 'rcp_ann', type: 'signature' } as SignFieldDto;

/** A draft that can be sent as it is. */
function ready(overrides: Partial<SignEnvelopeDetail> = {}): SignEnvelopeDetail {
  return {
    id: 'sgn_1',
    kind: 'envelope',
    title: 'Agreement',
    status: 'draft',
    message: null,
    signingOrderEnabled: false,
    reminderAfterDays: null,
    reminderEveryDays: null,
    reminderMaxCount: null,
    documents: [{ id: 'sgd_1', name: 'Agreement.pdf' }],
    recipientList: [ann],
    fields: [signature],
    canEdit: true,
    ...overrides,
  } as unknown as SignEnvelopeDetail;
}

function renderStep(envelope: SignEnvelopeDetail, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReviewStep envelope={envelope} editable={editable} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.permissions = new Set(['sign_envelopes:send']);
  for (const fn of Object.values(api.weldsign)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.weldsign.update.mockResolvedValue({ data: ready() });
  api.weldsign.send.mockResolvedValue({ data: ready({ status: 'sent' }) });
});

afterEach(() => cleanup());

describe('review step', () => {
  it('saves the message through the request API', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.type(screen.getByLabelText(tr.message), 'Please sign.');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { message: 'Please sign.' }));
  });

  it('turns reminders on with defaults', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('switch', { name: new RegExp(tr.reminders) }));
    await waitFor(() =>
      expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }),
    );
  });

  it('saves a changed reminder setting, within its limits', async () => {
    const user = userEvent.setup();
    renderStep(ready({ reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 }));
    const after = screen.getByLabelText(tr.reminderAfter);
    await user.clear(after);
    await user.type(after, '200');
    await user.tab();
    await waitFor(() => expect(api.weldsign.update).toHaveBeenCalledWith('sgn_1', { reminderAfterDays: 90 }));
  });

  it('counts documents, recipients and fields', () => {
    renderStep(ready());
    const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(stat(tr.summaryDocuments)).toBe('1');
    expect(stat(tr.summaryRecipients)).toBe('1');
    expect(stat(tr.summaryFields)).toBe('1');
  });

  it('says what stops the draft from being sent, naming the person', () => {
    renderStep(ready({ fields: [], documents: [] }));
    expect(screen.getByText(tr.noDocuments)).toBeInTheDocument();
    expect(screen.getByText('Ann has no signature field.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.send })).toBeDisabled();
  });

  it('says when nothing does', () => {
    renderStep(ready());
    expect(screen.getByText(tr.ready)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.send })).toBeEnabled();
  });

  it('hides Send without sign_envelopes:send, and when the draft cannot be changed', () => {
    state.permissions = new Set();
    renderStep(ready());
    expect(screen.queryByRole('button', { name: tr.send })).toBeNull();
    cleanup();

    state.permissions = new Set(['sign_envelopes:send']);
    renderStep(ready(), false);
    expect(screen.queryByRole('button', { name: tr.send })).toBeNull();
    expect(screen.getByLabelText(tr.message)).toBeDisabled();
  });

  it('asks for the expiry, then sends the draft', async () => {
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('button', { name: tr.send }));
    expect(screen.getByText(tr.sendTitle)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: tr.sendConfirm }));
    await waitFor(() => expect(api.weldsign.send).toHaveBeenCalledTimes(1));
    expect(api.weldsign.send.mock.calls[0]![0]).toBe('sgn_1');
    expect(api.weldsign.send.mock.calls[0]![1]).toEqual({ expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(tr.sent));
  });

  it('shows the server\'s reason when sending fails', async () => {
    api.weldsign.send.mockRejectedValue(new ApiError('Daily email limit reached', 400));
    const user = userEvent.setup();
    renderStep(ready());
    await user.click(screen.getByRole('button', { name: tr.send }));
    await user.click(screen.getByRole('button', { name: tr.sendConfirm }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`${tr.sendFailed}: Daily email limit reached`));
  });
});
