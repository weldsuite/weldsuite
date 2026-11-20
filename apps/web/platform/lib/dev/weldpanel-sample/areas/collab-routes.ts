/**
 * Shared pieces of the collab areas' request handling: a small router that
 * turns `{ method → handler }` tables into the usual list / create / read /
 * update / delete routes of one resource, so each resource only describes what
 * is special about it.
 */

import { UNHANDLED, type SampleRequest } from '../request';

export function notFound(what: string): Error {
  return new Error(`Sample data: ${what} not found`);
}

export function bodyAs<T>(body: unknown): T {
  return (body ?? {}) as T;
}

/** The new value when the input has one (even `null`), else what was there. */
export function orKeep<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}

export function findIndex<T extends { id: string }>(items: T[], id: string, what: string): number {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw notFound(what);
  return index;
}

/** Takes the item at `index` out of a store; a delete answers with no body. */
export function removeAt<T>(items: T[], index: number): undefined {
  items.splice(index, 1);
  return undefined;
}

type Method = SampleRequest['method'];

/** What a handler of the collection (`/panel/<area>`) gets. */
export interface CollectionContext {
  request: SampleRequest;
  /** One timestamp for the whole request. */
  now: string;
}

/** What a handler of one item (`/panel/<area>/:id[/:action]`) gets. */
export interface ItemContext<T> extends CollectionContext {
  id: string;
  index: number;
  current: T;
}

export type Verbs<C> = Partial<Record<Method, (context: C) => unknown>>;

export interface ResourceRoutes<T extends { id: string }> {
  /** The store the items live in, and what to call one when it isn't found. */
  items: T[];
  what: string;
  /** `GET /panel/<area>`, `POST /panel/<area>`. */
  collection: Verbs<CollectionContext>;
  /** `GET|PATCH|DELETE /panel/<area>/:id`. */
  item?: Verbs<ItemContext<T>>;
  /** Answer `UNHANDLED` for a method the item doesn't take before looking for the item (so a missing id isn't an error then). */
  methodFirst?: boolean;
  /** `POST /panel/<area>/:id/<action>` and the like, by the action's name. */
  actions?: Record<string, Verbs<ItemContext<T>>>;
}

function run<C>(verbs: Verbs<C> | undefined, method: Method, context: C): unknown {
  const handler = verbs?.[method];
  return handler ? handler(context) : UNHANDLED;
}

function verbsOf<T extends { id: string }>(routes: ResourceRoutes<T>, segments: string[]): Verbs<ItemContext<T>> | undefined {
  if (segments.length === 2) return routes.item;
  const action = segments[2];
  return segments.length === 3 && action ? routes.actions?.[action] : undefined;
}

/** Sends the request to the verb table of the collection, the item or one of its actions. */
export function routeResource<T extends { id: string }>(request: SampleRequest, routes: ResourceRoutes<T>): unknown {
  const { segments, method } = request;
  const now = new Date().toISOString();
  if (segments.length === 1) return run(routes.collection, method, { request, now });

  const id = segments[1];
  const verbs = verbsOf(routes, segments);
  // A resource with actions looks the item up for any deeper path, so a missing id is an error there too.
  if (!id || (!verbs && !routes.actions)) return UNHANDLED;
  if (routes.methodFirst && !verbs?.[method]) return UNHANDLED;

  const index = findIndex(routes.items, id, routes.what);
  return run(verbs, method, { request, now, id, index, current: routes.items[index]! });
}
