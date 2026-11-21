import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no scrollIntoView / matchMedia.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

afterEach(() => cleanup());
