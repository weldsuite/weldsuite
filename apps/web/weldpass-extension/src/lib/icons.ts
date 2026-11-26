import { createLucideIcon } from 'lucide-react';

/**
 * Lucide's `square-arrow-up-right-exit` (ISC licence), the "open elsewhere"
 * icon the extension uses: for opening a site or the web app in a tab.
 * lucide-react 0.544, the version the repo pins, doesn't ship it yet, so it
 * is built here from the same paths as lucide.dev. Switch to the package's
 * own export once lucide-react is upgraded.
 */
export const SquareArrowUpRightExit = createLucideIcon('square-arrow-up-right-exit', [
  ['path', { d: 'M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6', key: 'frame' }],
  ['path', { d: 'm21 3-9 9', key: 'arrow' }],
  ['path', { d: 'M15 3h6v6', key: 'head' }],
]);
