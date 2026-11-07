/**
 * WeldMerge cards in chat.
 *
 * WeldMerge posts into channels as `app:weldmerge` with `metadata.weldmerge =
 * {kind, pullRequestId?, issueId?, releaseId?, itemKey?}`, and a member can
 * share an issue or pull request with `/merge`, which sends the same shape. The
 * card holds only ids: the title, status and the buttons come from the live
 * record, read as the viewer, so a forged card shows nothing the viewer may not
 * already see.
 */

import {
  mergeChatCardMetadataSchema,
  type MergeChatCardKind,
  type MergeChatCardMetadata,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { MergeShareResult } from '@/hooks/queries/use-weldmerge-across-queries';

/** The card a message carries, or null for any other message or an unreadable shape. */
export function readWeldMergeCard(metadata: unknown): MergeChatCardMetadata | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const parsed = mergeChatCardMetadataSchema.safeParse((metadata as { weldmerge?: unknown }).weldmerge);
  return parsed.success ? parsed.data : null;
}

/** What a card needs to load: an issue, a pull request, a release, or nothing (the digest). */
export type WeldMergeCardSubject =
  | { type: 'issue'; id: string }
  | { type: 'pull_request'; id: string }
  | { type: 'release'; id: string }
  | { type: 'digest' };

/** The record a card is about, or null when the card lacks the id its kind needs. */
export function cardSubject(card: MergeChatCardMetadata): WeldMergeCardSubject | null {
  switch (card.kind) {
    case 'issue_created':
    case 'issue_done':
    case 'shared_issue':
      return card.issueId ? { type: 'issue', id: card.issueId } : null;
    case 'review_requested':
    case 'checks_failed':
    case 'pull_request_merged':
    case 'shared_pull_request':
      return card.pullRequestId ? { type: 'pull_request', id: card.pullRequestId } : null;
    case 'release_shipped':
      return card.releaseId ? { type: 'release', id: card.releaseId } : null;
    case 'daily_digest':
      return { type: 'digest' };
    default:
      return null;
  }
}

/** The kinds whose card offers *Approve* and *Snooze*. */
export function offersReviewActions(kind: MergeChatCardKind): boolean {
  return kind === 'review_requested';
}

/** The pull request a card's thread replies can also be posted on. */
export function cardPullRequestId(card: MergeChatCardMetadata | null): string | null {
  if (!card) return null;
  const subject = cardSubject(card);
  return subject?.type === 'pull_request' ? subject.id : null;
}

/** The message `/merge` sends for a picked item: plain text for clients without cards, plus the card metadata. */
export function shareMessage(result: MergeShareResult): { content: string; metadata: { weldmerge: MergeChatCardMetadata } } {
  const content = `${result.key} ${result.title}`;
  const weldmerge: MergeChatCardMetadata =
    result.type === 'issue'
      ? { kind: 'shared_issue', issueId: result.id }
      : { kind: 'shared_pull_request', pullRequestId: result.id };
  return { content, metadata: { weldmerge } };
}

/** `/merge payment bug` gives `payment bug`; null when the text is not a `/merge` search with a term. */
export function parseMergeSearch(text: string): string | null {
  const match = /^\/merge\s+(\S[\s\S]*)$/i.exec(text);
  const query = match?.[1]?.trim();
  return query ? query : null;
}

export interface ParsedIssueCommand {
  /** A team key typed right after `/issue` (`/issue PLAT Fix login`), upper-cased, when there is one. */
  teamKey: string | null;
  title: string;
}

/**
 * `/issue Fix login` or `/issue PLAT Fix login`. A first word that is a known team
 * key picks that team and the rest is the title; otherwise the whole text is the
 * title. Null when there is no title.
 */
export function parseIssueCommand(text: string, teamKeys: readonly string[]): ParsedIssueCommand | null {
  const match = /^\/issue\s+(\S[\s\S]*)$/i.exec(text);
  const rest = match?.[1]?.trim();
  if (!rest) return null;
  const [first = '', ...others] = rest.split(/\s+/);
  const key = first.toUpperCase();
  if (others.length > 0 && teamKeys.some((candidate) => candidate.toUpperCase() === key)) {
    return { teamKey: key, title: others.join(' ') };
  }
  return { teamKey: null, title: rest };
}
