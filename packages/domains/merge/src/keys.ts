/**
 * Issue keys in pull requests (ADR MERGE-003).
 *
 * A pull request links to an issue when its branch, title or body names the
 * issue's key (`PLAT-209`, case-insensitive: `plat-209-fix-tabs` counts). The
 * candidates found here are checked against the workspace's teams and issues
 * by the caller; a key whose team doesn't exist is ignored.
 *
 * Whether merging closes the issue depends on the words just before the key:
 * after "refs", "ref", "references", "part of", "related to" or "relates to"
 * it doesn't. A key in the branch name always closes. When a key appears more
 * than once, one closing mention is enough.
 *
 * The Rust twin is rust/modules/merge/src/keys.rs; keep the two in step (the
 * conformance suite compares the links both backends create).
 */

export interface IssueKeyMention {
  /** Upper-case team key, `PLAT`. */
  teamKey: string;
  number: number;
  /** `PLAT-209`. */
  key: string;
  /** Merging the pull request moves the issue to Done. */
  closes: boolean;
}

const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9])/g;

/** Words that make a mention a reference only. Matched at the end of the text before the key. */
const NON_CLOSING_RE = /(?:\b(?:refs?|references|part\s+of|related\s+to|relates\s+to))[\s:]*$/i;

/** The longest key prefix a team can have; also caps how far back the keyword search looks. */
const LOOKBEHIND = 24;

function scan(text: string, closingByDefault: boolean, out: Map<string, IssueKeyMention>, checkKeyword: boolean) {
  for (const match of text.matchAll(KEY_RE)) {
    const teamKey = match[1]!.toUpperCase();
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const key = `${teamKey}-${number}`;
    let closes = closingByDefault;
    if (checkKeyword) {
      const start = match.index ?? 0;
      const before = text.slice(Math.max(0, start - LOOKBEHIND), start);
      if (NON_CLOSING_RE.test(before)) closes = false;
    }
    const existing = out.get(key);
    if (existing) {
      existing.closes = existing.closes || closes;
    } else {
      out.set(key, { teamKey, number, key, closes });
    }
  }
}

/**
 * Every issue key a pull request mentions, in first-seen order (branch, then
 * title, then body).
 */
export function findIssueKeyMentions(input: {
  headRef?: string | null;
  title?: string | null;
  body?: string | null;
}): IssueKeyMention[] {
  const out = new Map<string, IssueKeyMention>();
  if (input.headRef) scan(input.headRef, true, out, false);
  if (input.title) scan(input.title, true, out, true);
  if (input.body) scan(input.body, true, out, true);
  return [...out.values()];
}

/** Splits `PLAT-209` (any case) into its parts, or null when it isn't a key. */
export function parseIssueKey(value: string): { teamKey: string; number: number; key: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(value.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const teamKey = match[1]!.toUpperCase();
  return { teamKey, number, key: `${teamKey}-${number}` };
}

export function formatIssueKey(teamKey: string, number: number): string {
  return `${teamKey}-${number}`;
}
