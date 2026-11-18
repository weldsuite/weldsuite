import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BODY, caretAt, type DocSelection } from '@weldsuite/docs-engine';
import type { DocController } from './model/doc-controller';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en }) };
});

import { LinkBubble, LinkEditor } from './link-popover';

const at = { left: 10, top: 20, height: 16 };

/** The few controller parts the link pop-ups use. */
function fakeController({ selection = caretAt(BODY, 3), link = null as { url: string; text: string } | null, readOnly = false } = {}) {
  return {
    selection: selection as DocSelection,
    readOnly,
    link: vi.fn(() => link),
    setLink: vi.fn(),
    removeLink: vi.fn(),
    openDialog: vi.fn(),
    goToAnchor: vi.fn(),
  };
}

const asController = (fake: ReturnType<typeof fakeController>) => fake as unknown as DocController;

describe('LinkEditor', () => {
  let onClose: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    onClose = vi.fn();
  });

  it('asks for the text and the address at a caret with no link, and adds both', async () => {
    const user = userEvent.setup();
    const ctl = fakeController();
    render(<LinkEditor controller={asController(ctl)} at={at} onClose={onClose} />);

    await user.type(screen.getByRole('textbox', { name: 'Text' }), 'WeldSuite');
    await user.type(screen.getByPlaceholderText('Paste a link or type an address'), 'weldsuite.org{Enter}');

    expect(ctl.setLink).toHaveBeenCalledWith('https://weldsuite.org', 'WeldSuite');
    expect(onClose).toHaveBeenCalled();
  });

  it('only asks for the address of a selection, and refuses one that is not a link', async () => {
    const user = userEvent.setup();
    const ctl = fakeController({ selection: { story: BODY, anchor: 0, head: 4 } });
    render(<LinkEditor controller={asController(ctl)} at={at} onClose={onClose} />);

    expect(screen.queryByRole('textbox', { name: 'Text' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Paste a link or type an address'), 'not a link');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByText('Enter a web address, email address or phone number.')).toBeInTheDocument();
    expect(ctl.setLink).not.toHaveBeenCalled();
    // Typing again clears the message.
    await user.type(screen.getByPlaceholderText('Paste a link or type an address'), 'x');
    expect(screen.queryByText('Enter a web address, email address or phone number.')).not.toBeInTheDocument();
  });

  it('starts from the link the caret is on, and keeps its text', async () => {
    const user = userEvent.setup();
    const ctl = fakeController({ link: { url: 'https://old.example', text: 'Old' } });
    render(<LinkEditor controller={asController(ctl)} at={at} onClose={onClose} />);

    const field = screen.getByDisplayValue('https://old.example');
    await user.clear(field);
    await user.type(field, 'mail@example.com{Enter}');

    expect(ctl.setLink).toHaveBeenCalledWith('mailto:mail@example.com', undefined);
  });
});

describe('LinkBubble', () => {
  it('shows a web address as a link that opens in a new tab, with Edit and Remove', async () => {
    const user = userEvent.setup();
    const ctl = fakeController();
    render(<LinkBubble controller={asController(ctl)} at={at} url="https://weldsuite.org/docs" onDismiss={vi.fn()} />);

    const address = screen.getByRole('link', { name: 'weldsuite.org/docs' });
    expect(address).toHaveAttribute('href', 'https://weldsuite.org/docs');
    expect(address).toHaveAttribute('target', '_blank');
    await user.click(screen.getByRole('button', { name: 'Edit link' }));
    expect(ctl.openDialog).toHaveBeenCalledWith('link');
    await user.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(ctl.removeLink).toHaveBeenCalled();
  });

  it('goes to a bookmark in the document instead of opening it', async () => {
    const user = userEvent.setup();
    const ctl = fakeController();
    render(<LinkBubble controller={asController(ctl)} at={at} url="#intro" onDismiss={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '#intro' }));
    expect(ctl.goToAnchor).toHaveBeenCalledWith('intro');
  });

  it('shows an unsafe address as plain text, and no edit buttons to a reader', () => {
    const ctl = fakeController({ readOnly: true });
    render(<LinkBubble controller={asController(ctl)} at={at} url="javascript:alert(1)" onDismiss={vi.fn()} />);

    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit link' })).not.toBeInTheDocument();
  });
});
