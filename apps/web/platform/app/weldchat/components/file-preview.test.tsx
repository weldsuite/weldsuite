import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render as baseRender, screen, within } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('./clip-player', () => ({
  ClipPlayer: ({ attachment }: { attachment: { clipType: string; durationSeconds: number } }) => (
    <div data-testid="clip">
      {attachment.clipType} {attachment.durationSeconds}s
    </div>
  ),
}));

import { FilePreview } from './file-preview';

const t = en.sweep.weldchat.filePreview;

afterEach(cleanup);

/** Renders in the English locale, re-rendering in it too. */
function render(ui: ReactNode) {
  const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider initialLanguage="en">{children}</I18nProvider>;
  return baseRender(ui, { wrapper });
}

function image(n: number) {
  return {
    id: `att_${n}`,
    fileName: `photo-${n}.png`,
    fileSize: 2048,
    mimeType: 'image/png',
    url: `https://files.test/photo-${n}.png`,
    thumbnailUrl: `https://files.test/photo-${n}-thumb.png`,
  };
}

/** Three images in one conversation, as the message list marks its scope. */
function renderConversation() {
  render(
    <div data-chat-image-scope>
      <FilePreview attachment={image(1)} />
      <FilePreview attachment={image(2)} />
      <FilePreview attachment={image(3)} />
    </div>,
  );
}

function openThumbnail(n: number) {
  fireEvent.click(screen.getByRole('button', { name: `photo-${n}.png` }));
  return screen.getByRole('dialog');
}

const position = (current: number, total: number) =>
  t.position.replace('{current}', String(current)).replace('{total}', String(total));

describe('FilePreview, an image', () => {
  it('shows the thumbnail, and the full image in the lightbox', () => {
    renderConversation();
    const thumbnail = screen.getByRole('img', { name: 'photo-2.png' });
    expect(thumbnail.getAttribute('src')).toBe('https://files.test/photo-2-thumb.png');

    const dialog = openThumbnail(2);
    const full = within(dialog).getByRole('img', { name: 'photo-2.png' });
    expect(full.getAttribute('src')).toBe('https://files.test/photo-2.png');
    expect(within(dialog).getByText(position(2, 3))).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: t.download }).getAttribute('href')).toBe(
      'https://files.test/photo-2.png',
    );
  });

  it("steps through the conversation's images with the arrows", () => {
    renderConversation();
    const dialog = openThumbnail(2);

    fireEvent.click(within(dialog).getByRole('button', { name: t.next }));
    expect(within(dialog).getByRole('img', { name: 'photo-3.png' })).toBeTruthy();
    expect(within(dialog).getByText(position(3, 3))).toBeTruthy();
    // The last image has no Next.
    expect(within(dialog).queryByRole('button', { name: t.next })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: t.previous }));
    fireEvent.click(within(dialog).getByRole('button', { name: t.previous }));
    expect(within(dialog).getByRole('img', { name: 'photo-1.png' })).toBeTruthy();
    // The first image has no Previous.
    expect(within(dialog).queryByRole('button', { name: t.previous })).toBeNull();
  });

  it('steps with the arrow keys, and stops at either end', () => {
    renderConversation();
    const dialog = openThumbnail(1);

    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(within(dialog).getByText(position(1, 3))).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(within(dialog).getByText(position(3, 3))).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(within(dialog).getByText(position(2, 3))).toBeTruthy();
    // Other keys leave the image alone.
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(within(dialog).getByText(position(2, 3))).toBeTruthy();
  });

  it('closes with a click beside the image, and with the close button', () => {
    renderConversation();
    fireEvent.click(within(openThumbnail(1)).getByRole('button', { name: t.closePreview }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(openThumbnail(1)).getByRole('button', { name: t.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows just itself outside a conversation (a pinned message), with the full image as thumbnail', () => {
    const { thumbnailUrl: _, ...pinned } = image(7);
    render(<FilePreview attachment={pinned} />);
    expect(screen.getByRole('img', { name: 'photo-7.png' }).getAttribute('src')).toBe('https://files.test/photo-7.png');

    const dialog = openThumbnail(7);
    expect(within(dialog).queryByText(position(1, 1))).toBeNull();
    expect(within(dialog).queryByRole('button', { name: t.previous })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: t.next })).toBeNull();
  });
});

describe('FilePreview, a clip', () => {
  it('plays a clip of the kind it says it is', () => {
    render(
      <FilePreview attachment={{ ...image(1), mimeType: 'video/webm', clipType: 'screen', durationSeconds: 42 }} />,
    );
    expect(screen.getByTestId('clip').textContent).toBe('screen 42s');
  });

  it('plays audio and video files that lost their clip type, from the MIME type', () => {
    const { rerender } = render(<FilePreview attachment={{ ...image(1), mimeType: 'audio/ogg' }} />);
    expect(screen.getByTestId('clip').textContent).toBe('audio 0s');
    rerender(<FilePreview attachment={{ ...image(1), mimeType: 'video/mp4', clipType: 'other' }} />);
    expect(screen.getByTestId('clip').textContent).toBe('video 0s');
  });
});

describe('FilePreview, another file', () => {
  it('shows the name, the size and a download link', () => {
    const file = { ...image(1), fileName: 'report.pdf', mimeType: 'application/pdf' };
    const { rerender } = render(<FilePreview attachment={{ ...file, fileSize: 512 }} />);
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('512 B')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('download')).toBe('report.pdf');

    rerender(<FilePreview attachment={{ ...file, fileSize: 2048 }} />);
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    rerender(<FilePreview attachment={{ ...file, fileSize: 3 * 1048576 }} />);
    expect(screen.getByText('3.0 MB')).toBeTruthy();
  });
});
