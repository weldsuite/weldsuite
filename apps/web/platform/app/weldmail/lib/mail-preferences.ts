/**
 * WeldMail landing-view preferences are stored per-user, per-workspace in the
 * `user_preferences.uiPreferences` JSONB (see `useUserPreferences` /
 * `useUpdateMailDefaultAccount` / `useUpdateMailLastAccount`). This module only
 * holds the shared sentinel for the unified ("All Accounts") inbox.
 */

/** Sentinel value representing the unified ("All Accounts") inbox. */
export const UNIFIED_ACCOUNT = 'unified';
