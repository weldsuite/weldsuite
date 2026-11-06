/**
 * Record links: what a ticket, a company or a chat channel shows of WeldMerge.
 * Creating them is `insertRecordLinks` in `./issues` (the same function backs
 * `POST /issues` with `links[]`); this file reads and removes them.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { MergeRecordType } from '@weldsuite/db/schema';
import { canAccessChannel } from '@weldsuite/chat-domain/channel-access';
import type { MergeRecordLinkedIssue } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import {
  iso,
  mergeIssuePullRequests,
  mergeIssues,
  mergeRecordLinks,
  mergeReleasePullRequests,
  mergeReleases,
  mergeTeams,
  type Db,
  type MergeRecordLinkRow,
} from './db';
import { recordLinkDto } from './mappers';

export async function findRecordLink(db: Db, issueId: string, linkId: string): Promise<MergeRecordLinkRow | null> {
  const [row] = await db
    .select()
    .from(mergeRecordLinks)
    .where(and(eq(mergeRecordLinks.id, linkId), eq(mergeRecordLinks.issueId, issueId)))
    .limit(1);
  return row ?? null;
}

export async function deleteRecordLink(db: Db, link: MergeRecordLinkRow): Promise<void> {
  await db.delete(mergeRecordLinks).where(eq(mergeRecordLinks.id, link.id));
}

/** Whether the caller holds a workspace permission (`hasContextPermission`). */
export type PermissionCheck = (permission: string) => Promise<boolean>;

/** The permission that lets a member read a linked ticket or company, and so its title. */
const RECORD_READ: Record<Exclude<MergeRecordType, 'chat_channel'>, string> = {
  desk_ticket: 'tickets:read',
  crm_company: 'companies:read',
};

/** Whether the caller may read a linked record's stored title. */
export type RecordTitleAccess = (recordType: MergeRecordType, recordId: string) => Promise<boolean>;

/**
 * A link's stored title is the record's (a ticket subject, a company name, a
 * channel name), not WeldMerge's: `merge_issues:read` alone does not show it.
 * The caller sees it with the linked module's read permission (`tickets:read`,
 * `companies:read`), or for a chat channel when they may read the channel
 * (`canAccessChannel`). Answers are kept for the request.
 */
export function recordTitleAccess(db: Db, userId: string, can: PermissionCheck): RecordTitleAccess {
  const answers = new Map<string, Promise<boolean>>();
  return (recordType, recordId) => {
    const key = recordType === 'chat_channel' ? `chat_channel:${recordId}` : recordType;
    let answer = answers.get(key);
    if (!answer) {
      answer = recordType === 'chat_channel' ? canAccessChannel(db, recordId, userId, { can }) : can(RECORD_READ[recordType]);
      answers.set(key, answer);
    }
    return answer;
  };
}

/** The links with `title: null` where the caller may not read the linked record. */
export async function withVisibleTitles<T extends { recordType: MergeRecordType; recordId: string; title: string | null }>(
  access: RecordTitleAccess,
  links: T[],
): Promise<T[]> {
  const out: T[] = [];
  for (const link of links) {
    out.push(link.title !== null && !(await access(link.recordType, link.recordId)) ? { ...link, title: null } : link);
  }
  return out;
}

type ShippedRelease = NonNullable<MergeRecordLinkedIssue['release']>;

/** For each issue, the latest shipped release (not deleted) that carries one of its pull requests. */
async function shippedReleases(db: Db, issueIds: string[]): Promise<Map<string, ShippedRelease>> {
  const out = new Map<string, ShippedRelease & { at: number }>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({
      issueId: mergeIssuePullRequests.issueId,
      id: mergeReleases.id,
      name: mergeReleases.name,
      version: mergeReleases.version,
      shippedAt: mergeReleases.shippedAt,
    })
    .from(mergeIssuePullRequests)
    .innerJoin(mergeReleasePullRequests, eq(mergeReleasePullRequests.pullRequestId, mergeIssuePullRequests.pullRequestId))
    .innerJoin(mergeReleases, eq(mergeReleases.id, mergeReleasePullRequests.releaseId))
    .where(
      and(
        inArray(mergeIssuePullRequests.issueId, issueIds),
        isNull(mergeIssuePullRequests.dismissedAt),
        eq(mergeReleases.status, 'shipped'),
        isNull(mergeReleases.deletedAt),
      ),
    );
  for (const r of rows) {
    const at = r.shippedAt?.getTime() ?? 0;
    const current = out.get(r.issueId);
    if (!current || at > current.at || (at === current.at && r.id > current.id)) {
      out.set(r.issueId, { id: r.id, name: r.name, version: r.version, shippedAt: iso(r.shippedAt), at });
    }
  }
  return new Map([...out].map(([issueId, { at: _at, ...release }]) => [issueId, release]));
}

/** The issues linked to a record, newest link first, each with the release that shipped it (if any). */
export async function listLinkedIssues(db: Db, recordType: MergeRecordType, recordId: string): Promise<MergeRecordLinkedIssue[]> {
  const rows = await db
    .select({ link: mergeRecordLinks, issue: mergeIssues, teamKey: mergeTeams.key })
    .from(mergeRecordLinks)
    .innerJoin(mergeIssues, eq(mergeIssues.id, mergeRecordLinks.issueId))
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(
      and(
        eq(mergeRecordLinks.recordType, recordType),
        eq(mergeRecordLinks.recordId, recordId),
        isNull(mergeIssues.deletedAt),
        isNull(mergeTeams.deletedAt),
      ),
    )
    .orderBy(desc(mergeRecordLinks.createdAt), desc(mergeRecordLinks.id));
  const releases = await shippedReleases(
    db,
    rows.map((r) => r.issue.id),
  );
  return rows.map((r) => ({
    link: recordLinkDto(r.link),
    issue: {
      id: r.issue.id,
      key: `${r.teamKey}-${r.issue.number}`,
      title: r.issue.title,
      status: r.issue.status,
      teamId: r.issue.teamId,
      teamKey: r.teamKey,
    },
    release: releases.get(r.issue.id) ?? null,
  }));
}
