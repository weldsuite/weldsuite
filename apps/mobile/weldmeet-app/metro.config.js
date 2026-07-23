const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// Prefer ESM ('module') over CJS ('main') for libraries that ship both.
// @cloudflare/realtimekit's CJS bundle trips a known crash in
// @babel/plugin-transform-block-scoping@7.28.5 ("visited.has is not a
// function"), so we route Metro at its ESM build instead. The trade-off:
// some packages' ESM entry points skip side-effect setup that the CJS one
// runs at require-time. The realtimekit-react-native polyfills (atob,
// TextDecoder, URL) are therefore imported eagerly from app/_layout.tsx —
// see the polyfill block at the top of that file.
config.resolver.resolverMainFields = ['react-native', 'browser', 'module', 'main'];

module.exports = config;
