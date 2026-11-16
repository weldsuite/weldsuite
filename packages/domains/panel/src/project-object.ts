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

export interface PanelPeoplePage {
  people: PanelPerson[];
  cursor: string | null;
  totalCount: number;
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
  /** Keeps sessions seen in the last five minutes. */
  touchLive(touches: PanelLiveTouch[]): Promise<void>;

  // --- panel-api side ----------------------------------------------------
  getPerson(userIdOrAnonId: string): Promise<PanelPerson | null>;
  listPeople(input: { search?: string; cursor?: string | null; limit: number }): Promise<PanelPeoplePage>;
  /** Profiles whose `$email` matches (case-insensitive), for the WeldCRM person card. */
  findByEmail(email: string): Promise<PanelPerson[]>;
  live(): Promise<{ visitors: number; sessions: PanelLiveSession[] }>;
  /** Removes the profile and links at once and adds the ids to the erased list every query excludes (GDPR). */
  erase(input: { workspaceId: string; projectId: string; userIdOrAnonId: string }): Promise<PanelErasure>;
  erasedIds(): Promise<string[]>;
  /** Whether any identity link exists: the query compiler adds the identity join only then. */
  hasIdentifiedUsers(): Promise<boolean>;
  /** Called by the maintenance job once the Iceberg rows are rewritten: the ids no longer need excluding. */
  clearErased(ids: string[]): Promise<void>;
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
