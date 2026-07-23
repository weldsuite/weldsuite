/// <reference types="vitest" />
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library cleanup — unmounts components between tests so
// queries don't leak across files. Vitest with globals:false means
// afterEach has to be imported explicitly.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement matchMedia; many components (responsive hooks,
// theme provider) call it during render.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom doesn't implement IntersectionObserver — used by virtualized
// lists, sticky headers, and lazy-loaded images.
if (typeof window !== 'undefined' && !('IntersectionObserver' in window)) {
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error -- minimal mock
  window.IntersectionObserver = MockIntersectionObserver;
}

// jsdom doesn't implement ResizeObserver — used by Radix popovers,
// charts, virtualized tables.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error -- minimal mock
  window.ResizeObserver = MockResizeObserver;
}

// jsdom doesn't implement scrollIntoView — cmdk (Command/Combobox) calls it
// on the active item whenever the selection changes.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
