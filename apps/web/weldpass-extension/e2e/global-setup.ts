/**
 * Builds the extension for the Playwright run into `e2e/.extension`, with
 * the fake server as its default server (`http://localhost:4510`, the
 * manifest then grants `http://localhost/*`). Pinned to the development id,
 * whose redirect the fake issuer checks exactly, as WeldID does.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, ISSUER } from './fake-server';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = path.resolve(here, '.extension');

export default function globalSetup(): void {
  const root = path.resolve(here, '..');
  const vitePackage = createRequire(path.join(root, 'package.json')).resolve('vite/package.json');
  const vite = path.join(path.dirname(vitePackage), 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [vite, 'build', '--mode', 'e2e'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEFAULT_SERVER: APP,
      VITE_DEFAULT_ISSUER: ISSUER,
      WELDPASS_OUT_DIR: EXTENSION_DIR,
    },
  });
  if (result.status !== 0) throw new Error('Building the extension for the Playwright run failed');
}
