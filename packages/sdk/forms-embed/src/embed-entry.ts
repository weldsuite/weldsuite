/**
 * Entry of the IIFE bundle (`dist/embed.js`, also served by forms-portal at
 * /embed.js): exposes `window.WeldForms` and starts the `[data-wf]` elements.
 */

import { autoInit, watch } from './auto';
import * as api from './index';

declare global {
  interface Window {
    WeldForms?: typeof api & { autoInit: typeof autoInit };
  }
}

if (typeof window !== 'undefined') {
  window.WeldForms = { ...api, autoInit };

  const start = () => {
    autoInit();
    watch();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
