import { describe, it, expect, afterEach } from 'vitest';
import { isEditableTarget, isEscapeHandledElsewhere } from './escape-guard';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('isEscapeHandledElsewhere', () => {
  it('is false for a plain target', () => {
    const el = mount('<div><button id="b">x</button></div>');
    expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: el.querySelector('#b') })).toBe(false);
    expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: document.body })).toBe(false);
  });

  it('is true when a Radix layer already dismissed itself (defaultPrevented)', () => {
    expect(isEscapeHandledElsewhere({ defaultPrevented: true, target: document.body })).toBe(true);
  });

  it('is true inside a popover wrapper, dialog, listbox or menu', () => {
    for (const html of [
      '<div data-radix-popper-content-wrapper><input id="i"></div>',
      '<div role="dialog"><input id="i"></div>',
      '<div role="listbox"><div id="i" role="option"></div></div>',
      '<div role="menu"><div id="i" role="menuitem"></div></div>',
      '<div cmdk-root><input id="i"></div>',
    ]) {
      const el = mount(html);
      expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: el.querySelector('#i') })).toBe(true);
    }
  });

  it('is true for an expanded combobox only', () => {
    const open = mount('<input id="i" role="combobox" aria-expanded="true">');
    expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: open })).toBe(true);
    const closed = mount('<input id="i" role="combobox" aria-expanded="false">');
    expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: closed })).toBe(false);
  });

  it('does not treat the native <dialog> side panel as a popup', () => {
    const el = mount('<dialog open><button id="b">x</button></dialog>');
    expect(isEscapeHandledElsewhere({ defaultPrevented: false, target: el.querySelector('#b') })).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('detects inputs, textareas and contenteditable', () => {
    expect(isEditableTarget(mount('<input>'))).toBe(true);
    expect(isEditableTarget(mount('<textarea></textarea>'))).toBe(true);
    expect(isEditableTarget(mount('<div contenteditable="true"></div>'))).toBe(true);
    expect(isEditableTarget(mount('<div contenteditable="false"></div>'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
