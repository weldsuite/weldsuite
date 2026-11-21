/**
 * Group analytics on the collector side: a batch's group profile operations go
 * to the project's PanelProject object, and its events keep `$group_<type>`
 * properties only for the project's group types (at most `MAX_GROUP_TYPES`;
 * a type takes a slot the first time data names it, while slots are free).
 *
 * The types are cached per isolate for a few minutes, so a batch asks the
 * object only when it names a type the cache doesn't know and slots may be
 * free. Without the object binding, or when it fails, properties are kept as
 * sent: the limit protects the reports, it must not lose data on a hiccup.
 * Group operations come only from batches sent with consent (the caller,
 * `collectInBackground`, drops them otherwise): an account ties events
 * together across visitors, so it is treated like identity (ADR PANEL-006).
 */

import { projectObjectStub, type PanelGroupOp } from '@weldsuite/panel-domain/project-object';
import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { groupTypeOfProperty, MAX_GROUP_TYPES, type WireGroupOp } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { warnOnce } from './warn';

const TYPES_TTL_MS = 5 * 60 * 1000;
const MAX_REMEMBERED_PROJECTS = 2000;

const knownTypes = new Map<string, { types: string[]; at: number }>();

type Project = Pick<PanelProjectRecord, 'workspaceId' | 'projectId'>;
type Props = Record<string, string | number | boolean | null>;
type WithProps = { props?: Props };

function remember(projectId: string, types: string[], now: number): void {
  if (knownTypes.size >= MAX_REMEMBERED_PROJECTS) knownTypes.clear();
  knownTypes.set(projectId, { types, at: now });
}

function logFailure(what: string, project: Project, error: unknown): void {
  console.error(`[panel-ingest] ${what} failed for project ${project.projectId}: ${error instanceof Error ? error.message : String(error)}`);
}

export function toGroupOps(ops: readonly WireGroupOp[]): PanelGroupOp[] {
  return ops.map((op): PanelGroupOp => {
    if (op.op === 'unset') return { op: 'unset', groupType: op.type, groupKey: op.key, keys: op.keys };
    return { op: op.op, groupType: op.type, groupKey: op.key, props: op.props };
  });
}

/** The group types the events' `$group_<type>` properties name. */
export function namedGroupTypes(events: readonly WithProps[]): string[] {
  const types = new Set<string>();
  for (const event of events) {
    for (const key of Object.keys(event.props ?? {})) {
      const type = groupTypeOfProperty(key);
      if (type) types.add(type);
    }
  }
  return [...types];
}

/** The events without the `$group_<type>` properties of types not in `allowed`, and how many were taken out. */
export function keepGroupProps<E extends WithProps>(events: readonly E[], allowed: readonly string[]): { events: E[]; dropped: number } {
  let dropped = 0;
  const kept = events.map((event): E => {
    const source = event.props;
    if (!source) return event;
    let props: Props | null = null;
    for (const key of Object.keys(source)) {
      const type = groupTypeOfProperty(key);
      if (type === null || allowed.includes(type)) continue;
      props ??= { ...source };
      delete props[key];
      dropped += 1;
    }
    return props === null ? event : { ...event, props };
  });
  return { events: kept, dropped };
}

/**
 * Applies the batch's group operations (when there are any) and answers the
 * project's group types, asking the object only when needed; null when the
 * types can't be known (no binding, or the call failed).
 */
export async function settleGroupTypes(
  env: Env,
  project: Project,
  ops: readonly WireGroupOp[],
  named: readonly string[],
  now: number,
): Promise<string[] | null> {
  if (ops.length === 0 && named.length === 0) return [];
  if (!env.PANEL_PROJECT) {
    warnOnce('binding:PANEL_PROJECT', 'PANEL_PROJECT is not bound: the live view, identities, people and groups are off');
    return null;
  }
  const stub = projectObjectStub(env.PANEL_PROJECT, project.projectId);
  let types: string[] | null = null;

  if (ops.length > 0) {
    try {
      const result = await stub.applyGroupOps({ workspaceId: project.workspaceId, projectId: project.projectId, ops: toGroupOps(ops) });
      types = result.types;
      remember(project.projectId, types, now);
      if (result.dropped > 0) {
        warnOnce(`groups:ops:${project.projectId}`, `Project ${project.projectId}: ${result.dropped} group operation(s) dropped (a type past its ${MAX_GROUP_TYPES}, or too large)`);
      }
    } catch (error) {
      logFailure('Group update', project, error);
    }
  }
  if (named.length === 0) return types;

  const cached = knownTypes.get(project.projectId);
  const known = types ?? (cached && now - cached.at < TYPES_TTL_MS ? cached.types : null);
  if (known && (named.every((type) => known.includes(type)) || known.length >= MAX_GROUP_TYPES)) return known;
  try {
    const taken = await stub.ensureGroupTypes([...named]);
    remember(project.projectId, taken, now);
    return taken;
  } catch (error) {
    logFailure('Group types lookup', project, error);
    return known;
  }
}

/** The events limited to the project's group types; reports how many properties were dropped, once per isolate and project. */
export async function limitGroups<E extends WithProps>(
  env: Env,
  project: Project,
  events: readonly E[],
  ops: readonly WireGroupOp[],
  now: number,
): Promise<E[]> {
  const named = namedGroupTypes(events);
  const allowed = await settleGroupTypes(env, project, ops, named, now);
  if (allowed === null || named.length === 0) return [...events];
  const { events: kept, dropped } = keepGroupProps(events, allowed);
  if (dropped > 0) {
    warnOnce(`groups:props:${project.projectId}`, `Project ${project.projectId}: $group_ properties of a type past its ${MAX_GROUP_TYPES} dropped (${dropped} in this batch)`);
  }
  return kept;
}

/** Forgets the cached group types. Tests only: an isolate keeps them. */
export function resetGroupTypesCache(): void {
  knownTypes.clear();
}
