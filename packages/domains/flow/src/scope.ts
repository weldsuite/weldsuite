/**
 * Project scope rules: the scope statement and the in and out of scope lists,
 * and the shapes they take on the wire and in entity events (design:
 * weldflow-project-control.md).
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-scope` routes use them, and the Rust flow-domain mirrors them.
 * Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type { OutOfScopeItem } from '@weldsuite/db/schema/project-control';
import type {
  OutOfScopeItemInput,
  Scope,
  ScopeLinkType,
} from '@weldsuite/app-api-client/schemas/project-governance';

type ScopeRow = typeof schema.projectScope.$inferSelect;

export const SCOPE_MESSAGES = {
  linkPair: 'linkType and linkId must be given together',
  linkNotFound: 'The linked object was not found in this project',
} as const;

/** What an out-of-scope item's link resolved to: its code and title, and a status. */
export interface ScopeLinkTarget {
  type: ScopeLinkType;
  id: string;
  code: string | null;
  title: string;
  status: string | null;
}

/** An out-of-scope item as it is stored: every field present, free text trimmed. */
export function normalizeOutOfScope(items: readonly OutOfScopeItemInput[]): OutOfScopeItem[] {
  return items.map((item) => ({
    text: item.text,
    reason: item.reason ? item.reason : null,
    linkType: item.linkType ?? null,
    linkId: item.linkType ? (item.linkId ?? null) : null,
  }));
}

/** The refusal (400) of an item whose link is half given, or null. */
export function outOfScopeLinkError(items: readonly OutOfScopeItemInput[]): string | null {
  for (const item of items) {
    if (!!item.linkType !== !!item.linkId) return SCOPE_MESSAGES.linkPair;
  }
  return null;
}

/** The `type:id` of an item's link, or null. */
export function scopeLinkKey(item: Pick<OutOfScopeItem, 'linkType' | 'linkId'>): string | null {
  return item.linkType && item.linkId ? `${item.linkType}:${item.linkId}` : null;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * The scope as the routes answer it. A project without a saved scope answers
 * the empty one (`id` and the audit fields null). `targets` holds what each
 * link resolved to, by `type:id`; a link left out of it shows as null.
 */
export function presentScope(
  projectId: string,
  row: ScopeRow | null,
  targets: ReadonlyMap<string, ScopeLinkTarget>,
): Scope {
  return {
    id: row?.id ?? null,
    projectId,
    statement: row?.statement ?? null,
    inScope: row?.inScope ?? [],
    outOfScope: (row?.outOfScope ?? []).map((item) => {
      const key = scopeLinkKey(item);
      const target = key ? targets.get(key) : undefined;
      return {
        text: item.text,
        reason: item.reason ?? null,
        linkType: item.linkType ?? null,
        linkId: item.linkId ?? null,
        link: target
          ? { type: target.type, id: target.id, code: target.code, title: target.title, status: target.status }
          : null,
      };
    }),
    createdBy: row?.createdBy ?? null,
    updatedBy: row?.updatedBy ?? null,
    createdAt: iso(row?.createdAt),
    updatedAt: iso(row?.updatedAt),
  };
}

/** The payload of a `project_scope` event. */
export function scopeEventData(row: ScopeRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    inScopeCount: row.inScope.length,
    outOfScopeCount: row.outOfScope.length,
  };
}
