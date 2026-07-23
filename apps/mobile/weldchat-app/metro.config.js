const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

// Only watch the specific workspace packages this app uses, not the entire monorepo
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/design/mobile-ui'),
  path.resolve(monorepoRoot, 'packages/core/realtime'),
  // app-api migration: weldchat now talks to app-api via these shared clients.
  // Metro can only bundle files whose symlink target is inside a watched folder.
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// Support package.json "exports" field (required for mobile-ui which uses type:module + exports)
config.resolver.unstable_enablePackageExports = true;

// Force packages that must be singletons to resolve from weldchat-app's node_modules only.
// Without this, mobile-ui's own dependencies (clerk, reanimated, etc.) get bundled twice,
// causing "Super expression must either be null or a function" at runtime.
const singletons = [
  'react',
  'react-native',
  'expo',
  '@clerk/expo',
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-gesture-handler',
  'react-native-safe-area-context',
  'react-native-svg',
  'expo-secure-store',
  'expo-notifications',
  'expo-haptics',
  'expo-linking',
  'mixpanel-react-native',
];

config.resolver.extraNodeModules = Object.fromEntries(
  singletons.map((pkg) => [pkg, path.resolve(monorepoRoot, 'node_modules', pkg)])
);

// @cloudflare/react-native-webrtc requires event-target-shim v6 (exports Event class).
// The hoisted v5 (from abort-controller/react-native) doesn't export Event, causing
// "Super expression must either be null or a function" at runtime.
// Force resolution to v6 when required from the webrtc package.
const eventTargetShimV6 = path.resolve(
  monorepoRoot,
  'node_modules/@cloudflare/react-native-webrtc/node_modules/event-target-shim'
);
// @tanstack/query-core's `exports` field only whitelists "." and "./package.json".
// With unstable_enablePackageExports on, Metro blocks the sibling .cjs files that
// build/modern/index.cjs requires (environmentManager.cjs, focusManager.cjs, ...).
// The package's `react-native` field already points at the TS source, so resolve
// there directly — Metro/Babel handles the TS and the internal imports are plain
// relative requires that don't hit the exports gate.
const queryCoreSrc = path.resolve(
  monorepoRoot,
  'node_modules/@tanstack/query-core/src/index.ts'
);
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'event-target-shim' &&
    context.originModulePath.includes('@cloudflare')
  ) {
    return context.resolveRequest(
      { ...context, resolveRequest: undefined },
      eventTargetShimV6 + '/index.js',
      platform
    );
  }
  if (moduleName === '@tanstack/query-core') {
    return context.resolveRequest(
      { ...context, resolveRequest: undefined },
      queryCoreSrc,
      platform
    );
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
