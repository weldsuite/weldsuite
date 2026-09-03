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

// Force packages that must be singletons to resolve from weldchat-app's
// node_modules when present. Prefer the app copy — the monorepo root may
// hoist an older react-native (e.g. 0.81) used by other apps, which breaks
// TurboModules ("PlatformConstants could not be found") against this app's
// 0.86 native binary.
const fs = require('fs');
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
  singletons.map((pkg) => {
    const appPath = path.resolve(projectRoot, 'node_modules', pkg);
    const rootPath = path.resolve(monorepoRoot, 'node_modules', pkg);
    return [pkg, fs.existsSync(appPath) ? appPath : rootPath];
  }),
);

// @cloudflare/react-native-webrtc does `class X extends EventTarget` in CJS that
// Metro/Babel may re-transpile. Native ES6 classes cannot be extended by
// Babel's ES5 class transform ("Class constructor invoked without new").
// Force the ES5 build of event-target-shim (function constructors).
const eventTargetShimV6 = path.resolve(projectRoot, 'node_modules/event-target-shim');
const eventTargetShimV6Fallback = path.resolve(monorepoRoot, 'node_modules/event-target-shim');
const eventTargetShimRoot = fs.existsSync(eventTargetShimV6)
  ? eventTargetShimV6
  : eventTargetShimV6Fallback;
const eventTargetShimEntry = path.join(eventTargetShimRoot, 'es5.js');
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'event-target-shim': eventTargetShimRoot,
};

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
  if (moduleName === 'event-target-shim') {
    return {
      type: 'sourceFile',
      filePath: eventTargetShimEntry,
    };
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
