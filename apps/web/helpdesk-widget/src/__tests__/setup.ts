import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { FakeResizeObserver } from './resize-observer';

// Vitest runs with globals off, so React Testing Library can't register its
// own cleanup: unmount between tests here.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; the conversation view measures its reply
// field with one. Tests that need a resize drive it through
// `resizeObservers` (src/__tests__/resize-observer.ts).
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: FakeResizeObserver });
}

// jsdom lays nothing out, so scrolling is a no-op that only has to exist.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {
    // nothing to scroll in jsdom
  };
}
