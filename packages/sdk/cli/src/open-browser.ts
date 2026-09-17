/**
 * Open a URL in the system browser (best-effort). Prints the URL if spawn fails.
 */

import { spawn } from 'node:child_process';
import { warn } from './log.js';

export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {
      warn(`Could not open a browser automatically. Open this URL:\n  ${url}`);
    });
    child.unref();
  } catch {
    warn(`Could not open a browser automatically. Open this URL:\n  ${url}`);
  }
}
