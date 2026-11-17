import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import { plural } from '@weldsuite/i18n/plural';

const api = vi.hoisted(() => ({
  load: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../lib/cancel-scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cancel-scheduled')>();
  return { ...actual, loadScheduledMessage: api.load, cancelScheduledToDraft: api.cancel };
});

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { plural: pick } = await import('@weldsuite/i18n/plural');
  return {
    useI18n: () => ({ t: english, plural: (count: number, forms: Parameters<typeof pick>[1]) => pick(count, forms, 'en') }),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useCancelScheduledEmail } from './cancel-scheduled-dialog';

function Harness() {
  const cancel = useCancelScheduledEmail();
  return (
    <>
      <button type="button" onClick={() => cancel.requestCancel('acc_1', 'msg_1')}>
        open
      </button>
      {cancel.dialog}
    </>
  );
}

function renderHarness() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}

const message = { subject: 'Plan', to: ['anna@x.com'] };
const ts = en.mail.scheduled;

describe('useCancelScheduledEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.cancel.mockResolvedValue({ success: true, draftId: 'draft_1' });
  });

  it('asks to move a mail without attachments to Drafts', async () => {
    api.load.mockResolvedValue({ success: true, message });
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByRole('button', { name: ts.cancelConfirmAction })).toBeInTheDocument();
    expect(screen.queryByText(plural(1, ts.cancelDropsAttachments, 'en'))).not.toBeInTheDocument();
  });

  it('says how many attachments are lost and only lets them go on a confirm that says so', async () => {
    api.load.mockResolvedValue({
      success: true,
      message: { ...message, attachments: [{ id: 'att_1' }, { id: 'att_2' }] },
    });
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(await screen.findByText(plural(2, ts.cancelDropsAttachments, 'en'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.cancelConfirmAction })).not.toBeInTheDocument();
    expect(api.cancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: ts.cancelConfirmActionWithoutAttachments }));
    expect(api.cancel).toHaveBeenCalledWith('acc_1', 'msg_1', expect.objectContaining({ subject: 'Plan' }));
  });

  it('cancels nothing when the mail cannot be read', async () => {
    api.load.mockResolvedValue({ success: false, error: 'Message not found' });
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
