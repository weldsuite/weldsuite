import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { AttachmentChip, formatAttachmentSize, type AttachmentChipData } from './attachment-chip';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english }) };
});

const copy = en.mail.messageDetail;

function chip(overrides: Partial<AttachmentChipData> = {}) {
  const onDownload = vi.fn();
  const att: AttachmentChipData = { id: 'attach_1', fileName: 'report.pdf', size: 2048, ...overrides };
  render(<AttachmentChip att={att} onDownload={onDownload} />);
  return { att, onDownload };
}

describe('formatAttachmentSize', () => {
  it('reads bytes, kilobytes and megabytes', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(3 * 1048576 + 104858)).toBe('3.1 MB');
  });
});

describe('AttachmentChip', () => {
  it('downloads a clean or unscanned file', async () => {
    const { att, onDownload } = chip({ scanStatus: 'clean' });
    const button = screen.getByRole('button', { name: /report\.pdf/ });
    expect(button).toHaveTextContent('2 KB');
    await userEvent.click(button);
    expect(onDownload).toHaveBeenCalledWith(att);
  });

  it('marks an infected file and offers nothing to click', () => {
    chip({ scanStatus: 'infected', scanSignature: 'Eicar-Signature' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(`${copy.attachmentInfected} · Eicar-Signature`)).toBeInTheDocument();
    expect(screen.getByTitle(`report.pdf: ${copy.attachmentInfectedHint.replace('{signature}', 'Eicar-Signature')}`)).toBeInTheDocument();
  });

  it('marks an infected file without a signature', () => {
    chip({ scanStatus: 'infected' });
    expect(screen.getByText(copy.attachmentInfected)).toBeInTheDocument();
  });

  it('holds a file that is still being scanned', () => {
    chip({ scanStatus: 'pending' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(copy.attachmentScanning)).toBeInTheDocument();
    expect(screen.getByTitle(copy.attachmentScanningHint)).toBeInTheDocument();
  });

  it('still downloads a file the scanner could not read, with a warning', async () => {
    const { onDownload } = chip({ scanStatus: 'error' });
    const button = screen.getByRole('button', { name: /report\.pdf/ });
    expect(button).toHaveAttribute('title', `report.pdf: ${copy.attachmentScanFailedHint}`);
    expect(screen.getByText(copy.attachmentScanFailed)).toBeInTheDocument();
    await userEvent.click(button);
    expect(onDownload).toHaveBeenCalledOnce();
  });
});
