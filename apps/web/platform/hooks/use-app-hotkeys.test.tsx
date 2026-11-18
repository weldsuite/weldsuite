import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSettingsHotkey } from './use-settings-hotkey';
import { useShortcutsHotkey } from './use-shortcuts-hotkey';

function press(key: string, { used = false } = {}) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  // An editor that handled the key itself (WeldDocs: subscript, its shortcuts list).
  if (used) event.preventDefault();
  window.dispatchEvent(event);
}

describe('app-wide hotkeys', () => {
  it('opens settings on Ctrl+, unless an editor already used the key', () => {
    const open = vi.fn();
    renderHook(() => useSettingsHotkey(open));
    press(',', { used: true });
    expect(open).not.toHaveBeenCalled();
    press(',');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens the shortcuts page on Ctrl+/ unless an editor already used the key', () => {
    const open = vi.fn();
    renderHook(() => useShortcutsHotkey(open));
    press('/', { used: true });
    expect(open).not.toHaveBeenCalled();
    press('/');
    expect(open).toHaveBeenCalledTimes(1);
  });
});
