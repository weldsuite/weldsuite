import { isApiError } from '@weldsuite/api-client';
import type { UserApp } from '@/hooks/queries/use-user-apps-queries';

function parseSemver(version: string): [number, number, number] | null {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return null;
  return [parts[0], parts[1], parts[2]];
}

export function bumpPatch(version: string): string {
  const parts = parseSemver(version);
  if (!parts) return '0.0.1';
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/** The highest `x.y.z` among `versions`, or null when none parse. */
export function latestVersion(versions: readonly string[]): string | null {
  let best: [number, number, number] | null = null;
  let bestRaw: string | null = null;
  for (const raw of versions) {
    const parsed = parseSemver(raw);
    if (!parsed) continue;
    const higher =
      !best ||
      parsed[0] > best[0] ||
      (parsed[0] === best[0] && (parsed[1] > best[1] || (parsed[1] === best[1] && parsed[2] > best[2])));
    if (higher) {
      best = parsed;
      bestRaw = raw;
    }
  }
  return bestRaw;
}

/**
 * The manifest the upload form starts from: the app's current manifest with
 * the version bumped past every version uploaded so far. The current
 * manifest alone isn't enough: a version awaiting review isn't current yet,
 * and a duplicate number is rejected with a 409.
 */
export function buildManifestTemplate(app: UserApp, existingVersions: readonly string[]): string {
  const lastManifest = (app.manifest ?? {}) as Record<string, unknown>;
  const manifestVersion = typeof lastManifest.version === 'string' ? lastManifest.version : null;
  const known = manifestVersion ? [...existingVersions, manifestVersion] : existingVersions;
  const scopes = Array.isArray(lastManifest.scopes) ? lastManifest.scopes : app.requestedScopes;
  return JSON.stringify(
    {
      code: app.code,
      name: app.name,
      version: bumpPatch(latestVersion(known) ?? '0.0.0'),
      scopes,
    },
    null,
    2,
  );
}

/**
 * The field errors of a rejected manifest (`{ formErrors, fieldErrors }` from
 * Zod's `flatten()`, in the error's `details`) as one line, e.g.
 * "version: semver (e.g. 1.0.0)". Null when the error carries none.
 */
export function manifestErrorDetails(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const details = (err.body as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!details || typeof details !== 'object') return null;
  const { formErrors, fieldErrors } = details as { formErrors?: unknown; fieldErrors?: unknown };
  const parts: string[] = [];
  if (Array.isArray(formErrors)) {
    parts.push(...formErrors.filter((m): m is string => typeof m === 'string'));
  }
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (Array.isArray(messages) && messages.length > 0) parts.push(`${field}: ${messages.join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
