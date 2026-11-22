import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { useSaveMailAttachment } from './use-save-mail-attachment';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  save: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english }) };
});

vi.mock('../lib/download-attachment', async (importActual) => {
  const actual = await importActual<typeof import('../lib/download-attachment')>();
  return { ...actual, saveMailAttachment: mocks.save };
});

const { MailAttachmentDownloadError } = await import('../lib/download-attachment');
const copy = en.mail.messageDetail;

function save() {
  renderHook(() => useSaveMailAttachment()).result.current('attach_1', 'report.pdf');
}

beforeEach(() => {
  mocks.toastError.mockClear();
  mocks.save.mockReset();
});

describe('useSaveMailAttachment', () => {
  it('saves the file and shows nothing when the download works', async () => {
    mocks.save.mockResolvedValue(undefined);
    save();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('attach_1', 'report.pdf'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('says the file has a virus when the server refuses an infected one', async () => {
    mocks.save.mockRejectedValue(new MailAttachmentDownloadError('blocked', 'ATTACHMENT_INFECTED'));
    save();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(copy.downloadBlockedInfected));
  });

  it('says the file is still being scanned while the scan is pending', async () => {
    mocks.save.mockRejectedValue(new MailAttachmentDownloadError('pending', 'ATTACHMENT_SCAN_PENDING'));
    save();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(copy.downloadBlockedScanPending));
  });

  it('falls back to the generic message for any other failure', async () => {
    mocks.save.mockRejectedValue(new Error('network'));
    save();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(copy.failedToDownloadAttachment));
  });
});
