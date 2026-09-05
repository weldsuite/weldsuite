const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages this app imports. Watching the whole
// monorepo hangs Metro on Windows (multi-GB RAM, long startup, slow rebundles).
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/design/mobile-ui'),
  path.resolve(monorepoRoot, 'packages/core/realtime'),
  path.resolve(monorepoRoot, 'packages/core/permissions'),
  path.resolve(monorepoRoot, 'packages/clients/api-client'),
  path.resolve(monorepoRoot, 'packages/clients/app-api-client'),
  path.resolve(monorepoRoot, 'packages/clients/personal-api-client'),
];

// Resolve only from this app and the workspace root, never from a nested
// node_modules. The dependency tree no longer contains a second copy of any
// native module, but this keeps a stray nested one from being bundled if it
// ever comes back — and it keeps pure-JS deps (nanoid, react-is) single too.
//
// The rest of what used to live here is now the SDK 57 default and was removed:
// `nodeModulesPaths` already resolves app → workspace root, package exports are
// on by default, and the `extraNodeModules` singleton map for
// react-native/expo-*/reanimated only masked duplication that no longer exists.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
