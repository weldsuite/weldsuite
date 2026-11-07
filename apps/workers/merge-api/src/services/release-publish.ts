/**
 * Publishing a release's notes elsewhere in WeldSuite: a WeldKnow page and/or an
 * email from a workspace mail account. Both run as the member who asked, so
 * the teamspace role and the mailbox access rules apply to them, and the
 * outbound mail guard counts the email.
 *
 * No Hono context: the route checks the permissions, publishes the other
 * modules' entity events (`knowledge_page.created`, `email.email_sent`) and
 * maps the failures.
 */

import { createKnowledgePage, type KnowledgeBlock, type KnowledgePageRow } from '@weldsuite/know-domain/pages';
import { MailSendError, sendAndPersist, type SendResult } from '@weldsuite/mail-domain/send';
import type { Env } from '../types';
import type { Db, MergeReleaseRow } from './db';

const text = (value: string): Array<Record<string, unknown>> => [{ type: 'text', text: value, styles: {} }];

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/** `[label](url)` reduced to `label` (a bracket pair that is not followed by a url stays as it is). */
function stripLinks(line: string): string {
  let out = '';
  let rest = line;
  for (;;) {
    const open = rest.indexOf('[');
    const close = open < 0 ? -1 : rest.indexOf('](', open);
    const end = close < 0 ? -1 : rest.indexOf(')', close);
    if (end < 0) return out + rest;
    out += rest.slice(0, open) + rest.slice(open + 1, close);
    rest = rest.slice(end + 1);
  }
}

/** Bold, code and link marks reduced to their text. */
function plainInline(line: string): string {
  return stripLinks(line).split('**').join('').split('__').join('').split('`').join('').trim();
}

/** The text after a list marker, or null when the line is not that kind of list item. */
function bulletText(line: string): string | null {
  const item = line.trimStart();
  return '-*+'.includes(item.charAt(0)) && item.charAt(1) === ' ' ? item.slice(2) : null;
}

function numberedText(line: string): string | null {
  const item = line.trimStart();
  let digits = 0;
  while (isDigit(item[digits])) digits++;
  const marker = item.charAt(digits);
  return digits > 0 && (marker === '.' || marker === ')') && item.charAt(digits + 1) === ' ' ? item.slice(digits + 2) : null;
}

/** Heading level (1-3) and its text, or null. */
function headingOf(line: string): { level: number; text: string } | null {
  let level = 0;
  while (line.charAt(level) === '#') level++;
  return level >= 1 && level <= 3 && line.charAt(level) === ' ' ? { level, text: line.slice(level + 1) } : null;
}

function blockOf(raw: string): KnowledgeBlock {
  const heading = headingOf(raw);
  if (heading) return { type: 'heading', props: { level: heading.level }, content: text(plainInline(heading.text)), children: [] };
  const bullet = bulletText(raw);
  if (bullet !== null) return { type: 'bulletListItem', content: text(plainInline(bullet)), children: [] };
  const numbered = numberedText(raw);
  if (numbered !== null) return { type: 'numberedListItem', content: text(plainInline(numbered)), children: [] };
  return { type: 'paragraph', content: text(plainInline(raw)), children: [] };
}

/** Markdown (headings, bullet and numbered lists, paragraphs) as BlockNote blocks. */
export function markdownToBlocks(markdown: string): KnowledgeBlock[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map(blockOf);
}

/** The page title and the default email subject. */
export function releaseTitle(release: MergeReleaseRow): string {
  return release.version ? `${release.name} ${release.version}` : release.name;
}

/** Writes the notes into a teamspace the member may write in (throws `SpaceNotFoundError` / `SpaceAccessError`). */
export function publishToKnowledge(
  db: Db,
  userId: string,
  release: MergeReleaseRow,
  spaceId: string,
  canManageAll: boolean,
): Promise<KnowledgePageRow> {
  return createKnowledgePage(db, userId, {
    spaceId,
    title: `Release notes: ${releaseTitle(release)}`,
    contentJson: markdownToBlocks(release.notes ?? ''),
    canManageAll,
  });
}

export interface PublishEmail {
  mailAccountId: string;
  to: string[];
  subject?: string;
}

/**
 * Sends the notes from the mail account as a new conversation. The send goes
 * through `sendAndPersist`, which runs the outbound guard and keeps a sent copy
 * (throws `MailSendError`).
 */
export function publishByEmail(
  env: Env,
  db: Db,
  ctx: { clerkOrgId: string; workspaceId: string; userId: string; waitUntil?: (promise: Promise<unknown>) => void },
  release: MergeReleaseRow,
  email: PublishEmail,
): Promise<SendResult> {
  return sendAndPersist(
    env,
    db,
    ctx.clerkOrgId,
    ctx.userId,
    email.mailAccountId,
    { to: email.to, subject: email.subject?.trim() || `Release notes: ${releaseTitle(release)}`, body: release.notes ?? '' },
    { waitUntil: ctx.waitUntil, outbound: { source: 'compose', kind: 'new_thread', workspaceId: ctx.workspaceId } },
  );
}

export { MailSendError };
