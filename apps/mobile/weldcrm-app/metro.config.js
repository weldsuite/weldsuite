const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages this app imports. Watching the whole
// monorepo hangs Metro on Windows (multi-GB RAM, long startup, slow rebundles).
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/design/mobile-ui'),
  path.resolve(monorepoRoot, 'packages/core/realtime'),
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = true;

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
  singletons.map((pkg) => [pkg, resolvePackageDir(pkg)]),
);

// RN's AbortController polyfill (abort-controller) does EventTarget.call(signal).
// The hoisted event-target-shim is v6 (pulled in by the WebRTC apps), whose
// default export is a native ES6 class, which throws "Class constructor invoked
// without new" under that pattern — an immediate production launch crash.
// abort-controller's own nested v5 copy is invisible because
// disableHierarchicalLookup is on, so force the ES5 build (same fix as
// weldmail/weldchat/weldflow/welddesk).
const eventTargetShimRoot = resolvePackageDir('event-target-shim');
const eventTargetShimEntry = path.join(eventTargetShimRoot, 'es5.js');
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'event-target-shim': eventTargetShimRoot,
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'event-target-shim') {
    return { type: 'sourceFile', filePath: eventTargetShimEntry };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
