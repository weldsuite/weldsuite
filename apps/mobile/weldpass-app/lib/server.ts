/**
 * Who this app is and what its build bakes in, for the server choice
 * (weldsuite-documentation/plans/mobile-server-choice.md, ADR MOB-006).
 *
 * WeldPass runs on WeldSuite EU and self-hosted servers only (Global is
 * retired, ADR OPS-025): it starts on the WeldSuite EU server its build
 * names, signs in through that server's identity provider (WeldID) and ships
 * no Clerk. With the picker on, "Change server" offers a self-hosted server
 * instead.
 *
 * `<ServerAuthRoot app={APP} build={BUILD}>` in `app/_layout.tsx` boots the
 * runtime from these; everything else reads `getMobileRuntime()` (inside a
 * function or component, never at module level).
 *
 * The `process.env.EXPO_PUBLIC_*` reads must stay here, written out in full:
 * Expo only inlines them in the app's own code.
 */

import type { MobileAppIdentity, MobileBuildEnv } from '@weldsuite/mobile-platform/runtime';

export const APP: MobileAppIdentity = {
  code: 'weldpass',
  name: 'WeldPass',
  // A server must run the WeldPass API for the app to work there.
  requiredModules: ['pass'],
  servers: ['eu', 'self-hosted'],
};

// The API and web hosts come from the server's /config.json.
export const BUILD: MobileBuildEnv = {
  euServerUrl: process.env.EXPO_PUBLIC_EU_SERVER_URL,
  serverPicker: process.env.EXPO_PUBLIC_SERVER_PICKER,
};
