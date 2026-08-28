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
  path.resolve(monorepoRoot, 'packages/clients/core-api-client'),
];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = true;

// Prefer ESM ('module') over CJS ('main') for libraries that ship both.
// @cloudflare/realtimekit's CJS bundle trips a known crash in
// @babel/plugin-transform-block-scoping@7.28.5 ("visited.has is not a
// function"), so we route Metro at its ESM build instead.
config.resolver.resolverMainFields = ['react-native', 'browser', 'module', 'main'];

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

module.exports = config;
