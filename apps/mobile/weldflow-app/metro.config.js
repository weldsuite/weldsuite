const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages this app imports. Watching the whole
// monorepo hangs Metro on Windows (multi-GB RAM, long startup, slow rebundles
// when switching between dev client and Expo Go).
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/design/mobile-ui'),
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// mobile-ui uses package.json "exports"; required for workspace resolution.
config.resolver.unstable_enablePackageExports = true;

// Keep one copy of native/runtime packages — prefer the app's SDK 57 copies,
// fall back to hoisted monorepo deps for packages not installed locally.
const fs = require('fs');

function resolvePackageDir(pkg) {
  const local = path.join(projectRoot, 'node_modules', pkg);
  if (fs.existsSync(local)) return local;
  return path.join(monorepoRoot, 'node_modules', pkg);
}

const singletons = [
  'react',
  'react-native',
  'expo',
  '@clerk/expo',
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-gesture-handler',
  'react-native-safe-area-context',
  'react-native-screens',
  'react-native-svg',
  'react-native-keyboard-controller',
  'expo-secure-store',
  'expo-notifications',
  'expo-haptics',
  'expo-linking',
  'mixpanel-react-native',
];

config.resolver.extraNodeModules = Object.fromEntries(
  singletons.map((pkg) => [pkg, resolvePackageDir(pkg)])
);

// RN's AbortController polyfill (abort-controller) does EventTarget.call(signal).
// event-target-shim v6's default export is a native ES6 class, which throws
// "Class constructor invoked without new" under that pattern. Force the ES5
// build (same fix as weldchat). Also pin resolution so we don't pick a
// mismatched hoisted copy from another app in the monorepo.
const eventTargetShimRoot = resolvePackageDir('event-target-shim');
const eventTargetShimEntry = path.join(eventTargetShimRoot, 'es5.js');
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'event-target-shim': eventTargetShimRoot,
};

// @tanstack/query-core's `exports` field only whitelists "." and "./package.json".
// With unstable_enablePackageExports on, Metro can miss sibling modules / ignore
// the package's `react-native` field. Resolve the TS source directly.
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
  if (moduleName === '@tanstack/query-core' && fs.existsSync(queryCoreSrc)) {
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
