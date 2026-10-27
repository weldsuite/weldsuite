/** Entry of `dist/panel.global.js`, served by the collector as `/s.js`. */

import { bootSnippet } from './snippet';

// Only readable while this script first runs, so read it here and not later.
bootSnippet(document.currentScript);
