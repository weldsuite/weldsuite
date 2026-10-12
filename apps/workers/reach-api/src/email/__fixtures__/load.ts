/** Test helper: read a `.eml` fixture as the CRLF bytes a mail server would deliver. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadFixtureText(name: string): string {
  return readFileSync(join(__dirname, name), 'utf8').replace(/\r?\n/g, '\r\n');
}

export function loadFixture(name: string): Uint8Array {
  return new TextEncoder().encode(loadFixtureText(name));
}
