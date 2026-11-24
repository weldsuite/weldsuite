const { getDefaultConfig } = require('expo/metro-config');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages this app imports. Watching the whole
// monorepo hangs Metro on Windows (multi-GB RAM, long startup, slow rebundles).
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/design/mobile-ui'),
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
  path.resolve(monorepoRoot, 'packages/clients/mobile-platform'),
  path.resolve(monorepoRoot, 'packages/core/api-modules'),
  path.resolve(monorepoRoot, 'packages/core/text'),
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
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-gesture-handler',
  'react-native-safe-area-context',
  'react-native-screens',
  'react-native-svg',
  'react-native-keyboard-controller',
  'expo-secure-store',
  'expo-haptics',
  'expo-linking',
  'expo-local-authentication',
  'zod',
];

config.resolver.extraNodeModules = Object.fromEntries(
  singletons.map((pkg) => [pkg, resolvePackageDir(pkg)]),
);

// RN's AbortController polyfill (abort-controller) does EventTarget.call(signal).
// The hoisted event-target-shim is v6, whose default export is a native ES6
// class, which throws "Class constructor invoked without new" under that
// pattern: an immediate production launch crash. Force the ES5 build (same fix
// as weldmail/weldchat/weldflow/welddesk).
const eventTargetShimRoot = resolvePackageDir('event-target-shim');
const eventTargetShimEntry = path.join(eventTargetShimRoot, 'es5.js');
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'event-target-shim': eventTargetShimRoot,
};

// WeldPass signs in through WeldID only (lib/server.ts: no WeldSuite cloud),
// so it ships no Clerk: the auth facade in @weldsuite/mobile-platform still
// imports its Clerk adapter for the apps that offer WeldSuite cloud, and here
// that import resolves to an empty module. The adapter is never chosen (the
// runtime refuses a Clerk server for this app). Drop this once the shared
// packages lose Clerk with the last Global app.
const isClerk = (moduleName) => moduleName === '@clerk/expo' || moduleName.startsWith('@clerk/');

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (isClerk(moduleName)) {
    return { type: 'empty' };
  }
  if (moduleName === 'event-target-shim') {
    return { type: 'sourceFile', filePath: eventTargetShimEntry };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
