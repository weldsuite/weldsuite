/**
 * The PanelProject Durable Object's RPC surface (ADR PANEL-004): one object
 * per project, in panel-ingest, holding people (profiles), identity links,
 * the erased ids and the live view. panel-ingest calls the collector side;
 * panel-api reaches the same class through a Durable Object binding with
 * `script_name` set to the collector worker and calls the read and erase side.
 *
 * Objects are created in the EU jurisdiction (profiles carry emails), so every
 * caller must get its stub through {@link projectObjectStub}: an id made
 * without the jurisdiction names a different object.
 *
 * On every profile or link change the object writes a row to `people_v1` or
 * `identities_v1` (./tables), so reports can join on them.
 */

export type PanelPropertyValue = string | number | boolean | null;

/** A profile operation from `people.set()` and friends (SDK or `/v1/track`). */
export type PanelPeopleOp =
  | { op: 'set'; userId: string; ts: string; props: Record<string, PanelPropertyValue> }
  | { op: 'set_once'; userId: string; ts: string; props: Record<string, PanelPropertyValue> }
  | { op: 'unset'; userId: string; ts: string; keys: string[] }
  | { op: 'increment'; userId: string; ts: string; props: Record<string, number> };

export interface PanelPerson {
  userId: string;
  /** `$email` property, lower-cased, if set. */
  email: string | null;
  /** `$name` property, if set. */
  name: string | null;
  properties: Record<string, PanelPropertyValue>;
  /** Anonymous ids linked to this user (devices, visits before login). */
  anonIds: string[];
  firstSeen: string;
  lastSeen: string;
}

/** What the collector reports for the live view, at most once per session per few seconds. */
export interface PanelLiveTouch {
  sessionId: string;
  distinctId: string;
  path: string;
  title: string | null;
  country: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | null;
  ts: string;
}

export interface PanelLiveSession extends PanelLiveTouch {
  startedAt: string;
  pageviews: number;
}

/** The live view keeps and answers the sessions with activity in the last 30 minutes. */
export const LIVE_WINDOW_MS = 30 * 60 * 1000;
/** `visitors` counts the visitors with activity in the last five minutes. */
export const LIVE_RECENT_MS = 5 * 60 * 1000;
/** `perMinute` has one bucket per minute of the window. */
export const LIVE_MINUTES = 30;
const MINUTE_MS = 60 * 1000;

/** The live view's counts, over every session kept in the window (not only the ones answered). */
export interface PanelLiveCounts {
  /** Distinct visitors with activity in the last five minutes. */
  visitors: number;
  /** Distinct visitors with activity in the last 30 minutes. */
  visitors30m: number;
  /**
   * Distinct visitors in each of the last 30 minutes, oldest first: bucket `i`
   * covers `[now - (30 - i) min, now - (29 - i) min)`, and a session counts in
   * every bucket from its start to its last activity.
   */
  perMinute: number[];
}

/** `live()`'s answer: the counts and the sessions of the last 30 minutes, latest first (at most 500). */
export interface PanelLive extends PanelLiveCounts {
  sessions: PanelLiveSession[];
}

/**
 * The live view's counts at `nowMs`. A row whose `ts` is before the window
 * (or not a time) counts nowhere; one whose `startedAt` is not a time counts
 * in `visitors` and `visitors30m` but in no minute. The Rust backend mirrors
 * this (`live_counts` in `rust/bins/weldsuite/src/panel_project/rules.rs`).
 */
export function liveCounts(rows: readonly Pick<PanelLiveSession, 'distinctId' | 'startedAt' | 'ts'>[], nowMs: number): PanelLiveCounts {
  const windowStart = nowMs - LIVE_WINDOW_MS;
  const recentStart = nowMs - LIVE_RECENT_MS;
  const recent = new Set<string>();
  const inWindow = new Set<string>();
  const minutes = Array.from({ length: LIVE_MINUTES }, () => new Set<string>());

  for (const row of rows) {
    const ts = Date.parse(row.ts);
    if (Number.isNaN(ts) || ts < windowStart) continue;
    inWindow.add(row.distinctId);
    if (ts >= recentStart) recent.add(row.distinctId);
    const startedAt = Date.parse(row.startedAt);
    minutes.forEach((visitors, i) => {
      const bucketStart = nowMs - (LIVE_MINUTES - i) * MINUTE_MS;
      const bucketEnd = bucketStart + MINUTE_MS;
      if (startedAt < bucketEnd && ts >= bucketStart) visitors.add(row.distinctId);
    });
  }

  return { visitors: recent.size, visitors30m: inWindow.size, perMinute: minutes.map((visitors) => visitors.size) };
}

export interface PanelPeoplePage {
  people: PanelPerson[];
  cursor: string | null;
  totalCount: number;
}

/**
 * A group profile operation (`group(type, key, props)`, `groups.set()` and
 * friends, from the SDKs and `/v1/track`). Types match `GROUP_TYPE` (./wire).
 */
export type PanelGroupOp =
  | { op: 'set'; groupType: string; groupKey: string; props: Record<string, PanelPropertyValue> }
  | { op: 'set_once'; groupType: string; groupKey: string; props: Record<string, PanelPropertyValue> }
  | { op: 'unset'; groupType: string; groupKey: string; keys: string[] };

/** A group's profile: a company, an account, a workspace. */
export interface PanelGroup {
  groupType: string;
  groupKey: string;
  properties: Record<string, PanelPropertyValue>;
  /** First and last profile operation for the group. */
  firstSeen: string;
  lastSeen: string;
}

export interface PanelGroupsPage {
  groups: PanelGroup[];
  cursor: string | null;
  totalCount: number;
}

/** What `applyGroupOps` did: operations of a type past the project's five are dropped. */
export interface PanelGroupOpsResult {
  applied: number;
  dropped: number;
  /** The project's group types after the call, in the order they were taken. */
  types: string[];
}

export interface PanelErasure {
  /** The user id erased, when the request named or resolved to one. */
  userId: string | null;
  /** Every id now excluded from queries (the user id and its anonymous ids). */
  erasedIds: string[];
}

/** Implemented by `PanelProject` in apps/workers/panel-ingest. */
export interface PanelProjectObjectApi {
  // --- collector side (panel-ingest) -------------------------------------
  /** Link `anonId` to `userId` (an anonymous id links to at most one user; the first link wins). */
  identify(input: { workspaceId: string; projectId: string; anonId: string; userId: string; ts: string }): Promise<{ linked: boolean }>;
  applyPeopleOps(input: { workspaceId: string; projectId: string; ops: PanelPeopleOp[] }): Promise<void>;
  /** Keeps sessions seen in the last 30 minutes ({@link LIVE_WINDOW_MS}), the newest 2000. */
  touchLive(touches: PanelLiveTouch[]): Promise<void>;

  // --- panel-api side ----------------------------------------------------
  getPerson(userIdOrAnonId: string): Promise<PanelPerson | null>;
  listPeople(input: { search?: string; cursor?: string | null; limit: number }): Promise<PanelPeoplePage>;
  /** Profiles whose `$email` matches (case-insensitive), for the WeldCRM person card. */
  findByEmail(email: string): Promise<PanelPerson[]>;
  /**
   * The live view: visitors in the last five and 30 minutes, visitors per
   * minute over the last 30 ({@link liveCounts}, over every kept session) and
   * the sessions with activity in the last 30 minutes, latest first (at most 500).
   */
  live(): Promise<PanelLive>;
  /** Removes the profile and links at once and adds the ids to the erased list every query excludes (GDPR). */
  erase(input: { workspaceId: string; projectId: string; userIdOrAnonId: string }): Promise<PanelErasure>;
  erasedIds(): Promise<string[]>;
  /** Whether any identity link exists: the query compiler adds the identity join only then. */
  hasIdentifiedUsers(): Promise<boolean>;
  /** Called by the maintenance job once the Iceberg rows are rewritten: the ids no longer need excluding. */
  clearErased(ids: string[]): Promise<void>;

  // --- groups (group analytics) -----------------------------------------
  //
  // A project collects at most `MAX_GROUP_TYPES` (./wire) group types. A type
  // takes a slot the first time an operation or an event names it (or when
  // panel-api creates it), while slots are free; operations of any other type
  // are dropped, and the collector drops its `$group_<type>` event properties.

  /** Collector side: applies the operations, one `groups_v1` snapshot row per changed group. */
  applyGroupOps(input: { workspaceId: string; projectId: string; ops: PanelGroupOp[] }): Promise<PanelGroupOpsResult>;
  /** Gives the named types a slot while there is room and answers the project's types (taken order). */
  ensureGroupTypes(types: string[]): Promise<string[]>;
  /** The project's group types, in the order they were taken. */
  groupTypes(): Promise<string[]>;
  /** Frees a type's slot (its profiles stay, and come back if the type is taken again). */
  releaseGroupType(groupType: string): Promise<void>;
  getGroup(groupType: string, groupKey: string): Promise<PanelGroup | null>;
  /** One type's groups, most recently seen first; `search` matches the key and the `$name` / `name` property. */
  listGroups(input: { groupType: string; search?: string; cursor?: string | null; limit: number }): Promise<PanelGroupsPage>;
  /** Removes the profile and writes a `deleted` row to `groups_v1`; false when there was none. */
  deleteGroup(input: { workspaceId: string; projectId: string; groupType: string; groupKey: string }): Promise<boolean>;
}

/** The binding shape both workers use; the real class satisfies {@link PanelProjectObjectApi}. */
export interface PanelProjectNamespace {
  jurisdiction?(jurisdiction: 'eu'): PanelProjectNamespace;
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): unknown;
}

/** The project's object, always in the EU jurisdiction (falls back where a test fake has no `jurisdiction`). */
export function projectObjectStub(namespace: PanelProjectNamespace, projectId: string): PanelProjectObjectApi {
  const ns = typeof namespace.jurisdiction === 'function' ? namespace.jurisdiction('eu') : namespace;
  return ns.get(ns.idFromName(projectId)) as PanelProjectObjectApi;
}
