/**
 * Legacy App Code Mapping
 *
 * Ported from apps/mobile-api-worker/src/lib/legacy-app-codes.ts.
 * The mobile app (weldsuite-app) still sends legacy app codes
 * (`helpdesk`, `mail`); the database uses the new codes
 * (`welddesk`, `weldmail`). This module translates inbound codes so
 * repointed mobile clients keep working against app-api.
 */

/** Map legacy mobile app codes → current DB codes */
export const LEGACY_TO_DB: Record<string, string> = {
  helpdesk: 'welddesk',
  mail: 'weldmail',
};

/** Map current DB codes → legacy mobile app codes */
export const DB_TO_LEGACY: Record<string, string> = {
  welddesk: 'helpdesk',
  weldmail: 'mail',
};

/** Translate a code from the mobile app to the DB code */
export function toDbCode(code: string): string {
  return LEGACY_TO_DB[code] || code;
}

/** Translate a DB code to the legacy code the mobile app expects */
export function toLegacyCode(code: string): string {
  return DB_TO_LEGACY[code] || code;
}
