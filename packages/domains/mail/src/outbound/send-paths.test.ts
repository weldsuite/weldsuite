/**
 * Guard: every source file that hands user-written mail to Cloudflare must go
 * through the outbound guard (docs/plans/weldmail-outbound-abuse.md). A new
 * send path that skips it fails here instead of quietly bypassing the limits.
 *
 * "Hands mail to Cloudflare" = calls `sendEmail` from @weldsuite/worker-email
 * (or personal-api's copy) or builds its own `CloudflareSendProvider`. Such a
 * file must call `guardedSend`, `checkOutbound` or `reserveOutbound`, or be on
 * the allowlist below with the reason it may not.
 *
 * System mail through @weldsuite/emails (`sendSystemEmail`) is not covered:
 * it is transactional, from WeldSuite's own address. The two system mails that
 * carry user-written text (calendar and WeldMeet invitations) call the guard in
 * their services.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../../..');

/** Files that send without a guard call of their own, and why that is fine. */
const ALLOWED: Record<string, string> = {
  // The transport itself; its only caller is services/mail-send.ts, which guards.
  'apps/workers/personal-api/src/lib/cloudflare-email.ts': 'transport, called from the guarded mail-send service',
};

const SEND_PATTERNS = [
  /\bcfEmail\.sendEmail\(/,
  /\bsendViaCloudflare\(/,
  /new CloudflareSendProvider\(/,
  /from '\.\.\/lib\/cloudflare-email'/,
  /import\('@weldsuite\/worker-email'\)/,
  /import \{[^}]*\bsendEmail\b[^}]*\} from '@weldsuite\/worker-email'/,
];
const GUARD_PATTERN = /\b(guardedSend|checkOutbound|reserveOutbound)\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'testing' || entry === '__fixtures__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('outbound send paths', () => {
  const roots = [join(repo, 'apps', 'workers'), join(repo, 'packages', 'domains')];
  const senders = roots
    .flatMap((root) => sourceFiles(root))
    .map((file) => ({ file: relative(repo, file).split(sep).join('/'), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => SEND_PATTERNS.some((re) => re.test(text)));

  it('finds the known send paths (so the scan itself still works)', () => {
    const files = senders.map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/domains/mail/src/send.ts',
        'packages/domains/mail/src/workflows/send-scheduled-email.ts',
        'packages/domains/crm/src/workflows/execute-workflow/action-handlers.ts',
      ]),
    );
  });

  it('every file that sends mail calls the outbound guard', () => {
    const unguarded = senders
      .filter(({ file, text }) => !GUARD_PATTERN.test(text) && !(file in ALLOWED))
      .map(({ file }) => file);
    expect(unguarded, 'call guardedSend / checkOutbound before sending, or add the file to ALLOWED with a reason').toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !senders.some((s) => s.file === file));
    expect(stale, 'remove allowlist entries that no longer send').toEqual([]);
  });
});
