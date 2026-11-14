/**
 * Who this app is and what its build bakes in, for the server choice
 * (WeldSuite cloud, EU, self-hosted; weldsuite-documentation/plans/mobile-server-choice.md).
 *
 * `<ServerRuntimeGate app={APP} build={BUILD}>` in `app/_layout.tsx` boots the
 * runtime from these; everything else reads `getMobileRuntime()` (inside a
 * function or component, never at module level).
 *
 * The `process.env.EXPO_PUBLIC_*` reads must stay here, written out in full:
 * Expo only inlines them in the app's own code.
 */

import type { MobileAppIdentity, MobileBuildEnv } from '@weldsuite/mobile-platform/runtime';

export const APP: MobileAppIdentity = {
  code: '{{APP_CODE}}',
  name: '{{APP_NAME}}',
  // API modules the app can't work without on a server, besides core
  // (`@weldsuite/api-modules` ids, e.g. 'crm').
  requiredModules: [],
};

export const BUILD: MobileBuildEnv = {
  appApiUrl: process.env.EXPO_PUBLIC_APP_API_URL,
  apiModules: process.env.EXPO_PUBLIC_API_MODULES,
  personalApiUrl: process.env.EXPO_PUBLIC_PERSONAL_API_URL,
  realtimeUrl: process.env.EXPO_PUBLIC_REALTIME_URL,
  platformUrl: process.env.EXPO_PUBLIC_PLATFORM_URL,
  clerkPublishableKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  euServerUrl: process.env.EXPO_PUBLIC_EU_SERVER_URL,
  serverPicker: process.env.EXPO_PUBLIC_SERVER_PICKER,
};
