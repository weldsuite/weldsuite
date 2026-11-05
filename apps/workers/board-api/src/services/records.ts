/**
 * What a record card shows: a WeldSuite record's title, a short subtitle and
 * its status, for the cards on a board (docs/plans/weldboard.md, records).
 *
 * A card only names a record; who may see what it says is the record's own
 * rule, applied here for each viewer: the permission global search uses for
 * the type (app-api `ENTITY_REGISTRY`), and for WeldFlow tasks and projects
 * the project's membership. A record the viewer may not see, or that is gone,
 * comes back as null and the card says so.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accessibleProjectIds } from '@weldsuite/flow-domain/project-access';
import type { BoardRecordKind, BoardRecordView } from '@weldsuite/app-api-client/schemas/boards';

/** The permission that lets someone see records of a kind (global search's). */
export const RECORD_PERMISSION: Record<BoardRecordKind, string> = {
  task: 'tasks:read',
  project: 'projects:read',
  company: 'contacts:read',
  person: 'contacts:read',
  opportunity: 'opportunities:read',
  ticket: 'tickets:read',
};

export interface RecordViewer {
  userId: string;
  /** Holds `projects:scope:all` (every live project). */
  scopeAll: boolean;
  /** The kinds whose permission the viewer holds. */
  kinds: ReadonlySet<BoardRecordKind>;
}

export const recordKey = (kind: string, id: string) => `${kind}:${id}`;

/** Views of `refs`, keyed `kind:id`; null for what the viewer may not see or what is gone. */
export async function resolveRecords(db: Database, viewer: RecordViewer, refs: { kind: BoardRecordKind; id: string }[]): Promise<Record<string, BoardRecordView | null>> {
  const out: Record<string, BoardRecordView | null> = {};
  for (const ref of refs) out[recordKey(ref.kind, ref.id)] = null;
  const idsOf = (kind: BoardRecordKind) => (viewer.kinds.has(kind) ? [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))] : []);
  const put = (kind: BoardRecordKind, id: string, view: BoardRecordView) => {
    out[recordKey(kind, id)] = view;
  };

  const taskIds = idsOf('task');
  const projectIds = idsOf('project');
  // Tasks and projects follow the project: the ids of the projects the viewer may open (null: all live ones).
  const openProjects = taskIds.length || projectIds.length ? await accessibleProjectIds(db, viewer.userId, { scopeAll: viewer.scopeAll }) : [];
  const projectOpen = (id: string | null) => !!id && (openProjects === null || openProjects.includes(id));

  await Promise.all([
    (async () => {
      if (!taskIds.length) return;
      const { tasks } = schema;
      const rows = await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, number: tasks.number, projectId: tasks.projectId, reporterId: tasks.reporterId, assigneeId: tasks.assigneeId })
        .from(tasks)
        .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)));
      for (const r of rows) {
        // A personal task (no project) is its reporter's and assignee's.
        const mine = r.reporterId === viewer.userId || r.assigneeId === viewer.userId;
        if (r.projectId ? projectOpen(r.projectId) : mine) put('task', r.id, { title: r.title, subtitle: r.number ? `#${r.number}` : null, status: r.status });
      }
    })(),
    (async () => {
      if (!projectIds.length) return;
      const { projects } = schema;
      const rows = await db
        .select({ id: projects.id, name: projects.name, status: projects.status, code: projects.code })
        .from(projects)
        .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)));
      for (const r of rows) if (projectOpen(r.id)) put('project', r.id, { title: r.name, subtitle: r.code ?? null, status: r.status });
    })(),
    (async () => {
      const ids = idsOf('company');
      if (!ids.length) return;
      const { companies } = schema;
      const rows = await db
        .select({ id: companies.id, name: companies.displayName, email: companies.email, status: companies.status })
        .from(companies)
        .where(and(inArray(companies.id, ids), isNull(companies.deletedAt)));
      for (const r of rows) put('company', r.id, { title: r.name, subtitle: r.email ?? null, status: r.status });
    })(),
    (async () => {
      const ids = idsOf('person');
      if (!ids.length) return;
      const { people } = schema;
      const rows = await db
        .select({ id: people.id, name: people.displayName, email: people.email })
        .from(people)
        .where(and(inArray(people.id, ids), isNull(people.deletedAt)));
      for (const r of rows) put('person', r.id, { title: r.name, subtitle: r.email ?? null, status: null });
    })(),
    (async () => {
      const ids = idsOf('opportunity');
      if (!ids.length) return;
      const { crmOpportunities: o } = schema;
      const rows = await db
        .select({ id: o.id, name: o.name, amount: o.amount, status: o.status })
        .from(o)
        .where(and(inArray(o.id, ids), isNull(o.deletedAt)));
      for (const r of rows) put('opportunity', r.id, { title: r.name, subtitle: r.amount && Number(r.amount) ? String(r.amount) : null, status: r.status });
    })(),
    (async () => {
      const ids = idsOf('ticket');
      if (!ids.length) return;
      const { helpdeskTickets: t } = schema;
      const rows = await db
        .select({ id: t.id, subject: t.subject, number: t.ticketNumber, status: t.status })
        .from(t)
        .where(and(inArray(t.id, ids), isNull(t.deletedAt)));
      for (const r of rows) put('ticket', r.id, { title: r.subject, subtitle: r.number, status: r.status });
    })(),
  ]);
  return out;
}
