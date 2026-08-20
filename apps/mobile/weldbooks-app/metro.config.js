const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// Three levels up: apps/mobile/weldbooks-app → repo root. Getting this wrong
// points nodeModulesPaths at a directory with no node_modules, and because
// `disableHierarchicalLookup` is on below, metro then cannot resolve ANY
// hoisted package — the bundle fails on expo-router's own entry point.
const monorepoRoot = path.resolve(projectRoot, '../../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
