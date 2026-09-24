/**
 * @weldsuite/permissions — App-scoped permission checks
 *
 * Objects that live inside apps are granted per app: `weldcrm:companies:read`
 * and `weldbooks:companies:read` are independent grants on the same object.
 * Callers keep asking for the unqualified `companies:read`; the check
 * qualifies it with the app the request comes from. Workspace-level objects
 * (`team`, `roles`, `billing`, …) are registered in no app and are checked
 * exactly as written.
 *
 * Resolution for an app-scoped key:
 *   - app context given and the object belongs to that app → check that app
 *   - no app context (MCP, API keys, AI agents, workflows, global search)
 *     → allowed when ANY app that exposes the object grants it
 *   - app context given but the object is not part of that app → same
 *     any-app fallback, flagged as `objectNotInApp` so callers can log the
 *     registry gap
 *
 * The any-app fallback is not a bypass: a caller could always name an app
 * that grants the key, so it allows nothing an explicit app header wouldn't.
 *
 * Denies (per-member) always win, and a deny on the unqualified key
 * (`companies:read`) denies it in every app.
 */

import { hasPermission } from './engine';
import { getAppsForObject, isAppCode, normalizeAppCode } from './apps';

/**
 * Transition switch. Grants stored before the per-app data migration are
 * unqualified (`companies:read`); while this is on they count as a grant in
 * every app, so nobody loses access before the migration rewrites them.
 * Turned off once every stored key is app-qualified.
 */
export const LEGACY_UNQUALIFIED_GRANTS = true;

export interface PermissionKeyParts {
  /** App segment when the key is already app-qualified, else null. */
  app: string | null;
  /** Object segment, e.g. "companies". */
  object: string;
  /** The key without its app segment, e.g. "companies:scope:all". */
  unqualified: string;
}

/**
 * Split a concrete (non-wildcard) permission key into app / object parts.
 * `weldcrm:companies:read` → app weldcrm; `companies:read` → app null. A
 * leading app code only counts as an app segment when the next segment is an
 * object of that app, so app-named workspace objects (`weldagent:use`) are
 * never mistaken for qualified keys.
 */
export function parsePermissionKey(key: string): PermissionKeyParts {
  const [first = '', second = '', third] = key.split(':');
  if (third !== undefined && isAppCode(first) && getAppsForObject(second).includes(first)) {
    return { app: first, object: second, unqualified: key.slice(first.length + 1) };
  }
  return { app: null, object: first, unqualified: key };
}

/**
 * Qualify a key with an app: `companies:read` + weldcrm →
 * `weldcrm:companies:read`. Already-qualified keys and workspace-level keys
 * come back unchanged.
 */
export function qualifyPermission(key: string, app: string): string {
  const parsed = parsePermissionKey(key);
  if (parsed.app || getAppsForObject(parsed.object).length === 0) return key;
  return `${app}:${key}`;
}

/** Anything that carries grants and (optionally) denies. */
export interface PermissionSubject {
  permissions: string[];
  denies?: string[];
}

export type AppCheckMode = 'workspace' | 'app' | 'any-app';

export interface AppPermissionCheck {
  allowed: boolean;
  /** How the key was evaluated. */
  mode: AppCheckMode;
  /** The app the key was checked against in 'app' mode, else null. */
  app: string | null;
  /**
   * An app context was supplied but the object is not registered in that
   * app, so the check fell back to any-app. Signals a registry gap.
   */
  objectNotInApp?: boolean;
}

function isDenied(subject: PermissionSubject, keys: string[]): boolean {
  const denies = subject.denies;
  if (!denies || denies.length === 0) return false;
  return keys.some((k) => hasPermission(denies, k));
}

function allowsInApp(subject: PermissionSubject, qualified: string, unqualified: string): boolean {
  if (isDenied(subject, [qualified, unqualified])) return false;
  if (hasPermission(subject.permissions, qualified)) return true;
  return LEGACY_UNQUALIFIED_GRANTS && hasPermission(subject.permissions, unqualified);
}

/**
 * Evaluate one required key for a subject in an app context.
 *
 * @param subject  - grants + denies (a `ResolvedPermissions` fits)
 * @param required - concrete key, qualified or not (`companies:read`)
 * @param app      - the request's app code, or null when it has none
 */
export function checkAppPermission(
  subject: PermissionSubject,
  required: string,
  app: string | null | undefined,
): AppPermissionCheck {
  const parsed = parsePermissionKey(required);

  if (parsed.app) {
    return {
      allowed: allowsInApp(subject, required, parsed.unqualified),
      mode: 'app',
      app: parsed.app,
    };
  }

  const apps = getAppsForObject(parsed.object);
  if (apps.length === 0) {
    return {
      allowed: !isDenied(subject, [required]) && hasPermission(subject.permissions, required),
      mode: 'workspace',
      app: null,
    };
  }

  const appCode = app ? normalizeAppCode(app) : null;
  if (appCode && apps.includes(appCode)) {
    return {
      allowed: allowsInApp(subject, `${appCode}:${required}`, required),
      mode: 'app',
      app: appCode,
    };
  }

  return {
    allowed: apps.some((a) => allowsInApp(subject, `${a}:${required}`, required)),
    mode: 'any-app',
    app: null,
    ...(appCode ? { objectNotInApp: true } : {}),
  };
}

/** Boolean shorthand for {@link checkAppPermission}. */
export function hasAppPermission(
  subject: PermissionSubject,
  required: string,
  app: string | null | undefined,
): boolean {
  return checkAppPermission(subject, required, app).allowed;
}

/** True when ANY of the required keys is allowed in the app context. */
export function hasAnyAppPermission(
  subject: PermissionSubject,
  required: string[],
  app: string | null | undefined,
): boolean {
  return required.some((r) => checkAppPermission(subject, r, app).allowed);
}
