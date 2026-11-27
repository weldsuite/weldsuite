import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { isDialogOpen, isTypingTarget, shortcutFor, useProcessShortcuts, type ProcessShortcut } from './process-shortcuts';

function press(key: string, init: Partial<KeyboardEventInit> = {}, target: Element = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function Harness({ handlers, enabled = true }: Readonly<{ handlers: Partial<Record<ProcessShortcut, () => void>>; enabled?: boolean }>) {
  useProcessShortcuts(enabled, handlers);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <div contentEditable suppressContentEditableWarning aria-label="editable" data-testid="editable" />
      <button type="button">button</button>
      <div role="combobox" aria-expanded="false" aria-controls="x" tabIndex={0} data-testid="combo" />
    </div>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shortcutFor', () => {
  it('maps the keys of the plan', () => {
    const keys: Array<[string, ProcessShortcut]> = [
      ['j', 'next'],
      ['K', 'previous'],
      ['Enter', 'accept'],
      ['c', 'category'],
      ['r', 'receipt'],
      ['t', 'transfer'],
      ['p', 'private'],
      ['i', 'ignore'],
      ['u', 'undo'],
      ['?', 'help'],
      ['Escape', 'close'],
    ];
    for (const [key, shortcut] of keys) {
      expect(shortcutFor({ key, target: document.body, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, repeat: false, defaultPrevented: false })).toBe(shortcut);
    }
  });

  it('ignores other keys and modified presses', () => {
    const base = { target: document.body, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, repeat: false, defaultPrevented: false };
    expect(shortcutFor({ ...base, key: 'x' })).toBeNull();
    expect(shortcutFor({ ...base, key: 'c', metaKey: true })).toBeNull();
    expect(shortcutFor({ ...base, key: 'c', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ ...base, key: 'u', isComposing: true })).toBeNull();
  });
});

describe('typing and dialogs', () => {
  it('knows typing targets', () => {
    document.body.innerHTML = '<input id="a"><select id="b"></select><div contenteditable id="c"></div><div role="listbox"><div role="option" id="d"></div></div><p id="e"></p>';
    for (const id of ['a', 'b', 'c', 'd']) expect(isTypingTarget(document.getElementById(id))).toBe(true);
    expect(isTypingTarget(document.getElementById('e'))).toBe(false);
  });

  it('knows an open dialog', () => {
    expect(isDialogOpen()).toBe(false);
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    expect(isDialogOpen()).toBe(true);
    document.body.innerHTML = '<div role="dialog" data-state="closed"></div>';
    expect(isDialogOpen()).toBe(false);
  });
});

describe('useProcessShortcuts', () => {
  it('runs the handler and stops the default action', () => {
    const accept = vi.fn();
    const next = vi.fn();
    render(<Harness handlers={{ accept, next }} />);
    expect(press('Enter').defaultPrevented).toBe(true);
    press('j');
    expect(accept).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not fire while focus is in an input, textarea, contenteditable or combobox', () => {
    const category = vi.fn();
    const { getByLabelText, getByTestId } = render(<Harness handlers={{ category }} />);
    press('c', {}, getByLabelText('field'));
    press('c', {}, getByLabelText('area'));
    press('c', {}, getByTestId('editable'));
    press('c', {}, getByTestId('combo'));
    expect(category).not.toHaveBeenCalled();
    press('c');
    expect(category).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter to a focused button', () => {
    const accept = vi.fn();
    const { getByRole } = render(<Harness handlers={{ accept }} />);
    const event = press('Enter', {}, getByRole('button'));
    expect(accept).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not fire while a dialog is open', () => {
    const undo = vi.fn();
    render(
      <>
        <Harness handlers={{ undo }} />
        <div role="dialog" data-state="open" />
      </>,
    );
    press('u');
    expect(undo).not.toHaveBeenCalled();
  });

  it('lets only the queue keys repeat', () => {
    const next = vi.fn();
    const ignore = vi.fn();
    render(<Harness handlers={{ next, ignore }} />);
    press('j', { repeat: true });
    press('i', { repeat: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(ignore).not.toHaveBeenCalled();
  });

  it('does nothing when disabled, and leaves keys without a handler alone', () => {
    const accept = vi.fn();
    const { rerender } = render(<Harness handlers={{ accept }} enabled={false} />);
    press('Enter');
    expect(accept).not.toHaveBeenCalled();
    rerender(<Harness handlers={{ accept }} />);
    expect(press('Escape').defaultPrevented).toBe(false);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
