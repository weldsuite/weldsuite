/**
 * Password health: which of the caller's logins are weak, reused or stale.
 *
 * Computed on demand by opening the logins, rather than from stored
 * fingerprints. Spotting reuse from the database would need a hash of every
 * password sitting next to its ciphertext, and an unsalted hash of a
 * human-chosen password is most of the way to the password. Doing the work in
 * memory keeps the stored rows useless on their own.
 *
 * The report names items and verdicts. A password never leaves this module.
 */

import { passwordStrength } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import type { ItemSummary, OpenedLogin } from './password-items';

export type PasswordIssue = 'weak' | 'reused' | 'old';

/** A password nobody has changed in this long is worth a second look. */
export const OLD_PASSWORD_DAYS = 365;

export interface PasswordHealthEntry extends ItemSummary {
  issues: PasswordIssue[];
  /** How many of the caller's logins share this password, itself included. */
  reuseCount: number;
}

export interface PasswordHealthReport {
  /** Logins that have a password at all. */
  checked: number;
  healthy: number;
  weak: number;
  reused: number;
  old: number;
  /** Only the logins with something to fix, worst first. */
  items: PasswordHealthEntry[];
}

export function buildHealthReport(
  logins: OpenedLogin[],
  now: Date = new Date(),
): PasswordHealthReport {
  const withPassword = logins.filter((login) => login.password);

  const uses = new Map<string, number>();
  for (const { password } of withPassword) uses.set(password, (uses.get(password) ?? 0) + 1);

  const staleBefore = now.getTime() - OLD_PASSWORD_DAYS * 24 * 60 * 60 * 1000;
  const report: PasswordHealthReport = {
    checked: withPassword.length,
    healthy: 0,
    weak: 0,
    reused: 0,
    old: 0,
    items: [],
  };

  for (const { item, password } of withPassword) {
    const issues: PasswordIssue[] = [];
    const reuseCount = uses.get(password) ?? 1;

    if (passwordStrength(password) === 'weak') issues.push('weak');
    if (reuseCount > 1) issues.push('reused');
    if (item.passwordChangedAt && item.passwordChangedAt.getTime() < staleBefore) {
      issues.push('old');
    }

    if (issues.length === 0) {
      report.healthy += 1;
      continue;
    }
    for (const issue of issues) report[issue] += 1;
    report.items.push({ ...item, issues, reuseCount });
  }

  report.items.sort((a, b) => b.issues.length - a.issues.length || a.title.localeCompare(b.title));
  return report;
}
