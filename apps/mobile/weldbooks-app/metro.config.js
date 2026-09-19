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
  path.resolve(monorepoRoot, 'packages/core/realtime'),
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
  path.resolve(monorepoRoot, 'apps/mobile/_shared'),
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

// @tanstack/query-core's `exports` field only whitelists "." and "./package.json".
// With unstable_enablePackageExports on, Metro can miss sibling modules. Resolve
// the TS source directly (same fix as weldflow-app / weldstash-app).
const queryCoreSrc = path.resolve(
  monorepoRoot,
  'node_modules/@tanstack/query-core/src/index.ts'
);
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
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
