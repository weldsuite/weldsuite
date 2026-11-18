import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let pathname = '/welddocs/doc_1';
vi.mock('@/lib/router', () => ({ usePathname: () => pathname }));

import { DocSkeleton, WeldDocsPendingSkeleton, isDocPath } from '../doc/doc-skeleton';
import { keepTypingFocus } from './toolbar';
import { Menu, focusDialogItself } from './ui';

describe('DocSkeleton', () => {
  it('knows a document URL from the list, in the app and in the preview', () => {
    expect(isDocPath('/w/acme/welddocs/doc_1')).toBe(true);
    expect(isDocPath('/preview/welddocs/doc_1/')).toBe(true);
    expect(isDocPath('/w/acme/welddocs')).toBe(false);
  });

  it('draws a document while one loads, and the generic skeleton on the list', () => {
    pathname = '/welddocs/doc_1';
    const { container, unmount } = render(<WeldDocsPendingSkeleton />);
    expect(container.querySelector('[data-slot="doc-pending"]')).not.toBeNull();
    unmount();

    pathname = '/welddocs';
    const list = render(<WeldDocsPendingSkeleton />);
    expect(list.container.querySelector('[data-slot="doc-pending"]')).toBeNull();
    expect(list.container.querySelector('[data-slot="route-pending"]')).not.toBeNull();
  });

  it('adds the app header band only before the WeldDocs layout is there', () => {
    const withHeader = render(<DocSkeleton withAppHeader />);
    const without = render(<DocSkeleton />);
    const bands = (c: HTMLElement) => c.querySelectorAll('[data-slot="doc-pending"] > div').length;
    expect(bands(withHeader.container)).toBe(bands(without.container) + 1);
  });
});

describe('keepTypingFocus', () => {
  const press = (target: HTMLElement) => {
    const preventDefault = vi.fn();
    keepTypingFocus({ target, preventDefault } as unknown as React.MouseEvent);
    return preventDefault;
  };

  it('keeps typing in the document on a press on the toolbar itself', () => {
    expect(press(document.createElement('div'))).toHaveBeenCalled();
    expect(press(document.createElement('button'))).toHaveBeenCalled();
  });

  it('lets its fields take focus', () => {
    expect(press(document.createElement('input'))).not.toHaveBeenCalled();
  });
});

describe('focusDialogItself', () => {
  it('focuses the dialog instead of its first button', () => {
    const dialog = document.createElement('div');
    dialog.tabIndex = -1;
    document.body.append(dialog);
    const event = { preventDefault: vi.fn(), currentTarget: dialog } as unknown as Event;
    focusDialogItself(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(dialog);
    dialog.remove();
  });
});

describe('Menu', () => {
  it('shows a shortcut at the right of its command, the check in its own column', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Menu
        label="Align"
        trigger="A"
        items={[
          { key: 'left', label: 'Left align (Ctrl+Shift+L)', checked: true, onSelect },
          { key: 'centre', label: 'Centre align (Ctrl+Shift+E)', checked: false, onSelect },
          { key: 'plain', label: 'Single', onSelect },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Align' }));
    const left = await screen.findByRole('menuitemradio', { name: /Left align/ });
    expect(left.textContent).toBe('Left alignCtrl+Shift+L');
    expect(left.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe('Ctrl+Shift+L');
    // An unchecked choice keeps the check's room, hidden.
    expect(screen.getByRole('menuitemradio', { name: /Centre align/ }).querySelector('svg.invisible')).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Single' }).querySelector('[data-slot="dropdown-menu-shortcut"]')).toBeNull();

    await user.click(left);
    expect(onSelect).toHaveBeenCalled();
  });
});
