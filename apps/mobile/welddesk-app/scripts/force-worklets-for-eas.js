/**
 * EAS + shamefully-hoist + node-linker=hoisted flatten every workspace
 * app into one root node_modules. WeldBooks/WeldFlow pin
 * react-native-worklets@0.10.1, which Reanimated 4.1.x (Expo 54) rejects.
 *
 * After install, replace the hoisted copy with 0.5.1 so
 * :react-native-reanimated:assertWorkletsVersionTask passes.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.EAS_BUILD !== 'true') {
  process.exit(0);
}

function findWorkspaceRoot(start) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(start, '../../..');
}

function currentVersion(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

const appDir = path.resolve(__dirname, '..');
const root = findWorkspaceRoot(appDir);
const targets = [
  path.join(root, 'node_modules', 'react-native-worklets'),
  path.join(appDir, 'node_modules', 'react-native-worklets'),
];

console.log(
  `[welddesk-eas] workspace root=${root} hoisted worklets=${currentVersion(targets[0]) ?? 'missing'}`,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'welddesk-worklets-'));
execSync('npm pack react-native-worklets@0.5.1 --pack-destination .', {
  cwd: tmp,
  stdio: 'inherit',
});
const tgz = fs.readdirSync(tmp).find((name) => name.endsWith('.tgz'));
if (!tgz) throw new Error('npm pack did not produce a tarball');

execSync(`tar -xzf "${path.join(tmp, tgz)}"`, { cwd: tmp, stdio: 'inherit' });
const extracted = path.join(tmp, 'package');
if (!fs.existsSync(path.join(extracted, 'package.json'))) {
  throw new Error('unpacked worklets package is missing package.json');
}

for (const dest of targets) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(extracted, dest, { recursive: true });
}

const pinned = currentVersion(targets[0]);
if (pinned !== '0.5.1') {
  throw new Error(`Expected react-native-worklets@0.5.1 at repo root, got ${pinned}`);
}
console.log('[welddesk-eas] react-native-worklets pinned to', pinned);
