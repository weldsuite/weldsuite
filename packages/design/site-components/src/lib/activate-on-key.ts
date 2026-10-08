import type { KeyboardEvent } from 'react';

/**
 * Keyboard handler for a clickable element that can't be a native <button>
 * (it contains other controls): Enter and Space run `activate`. Key presses that
 * bubble up from a nested control are ignored so they keep their own behaviour.
 */
export function activateOnKey(activate: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
}
