import { eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { ChannelPreferences, Database, ModulePreferencesMap } from './types';

/**
 * Resolve which notification channels are enabled for a user + category.
 * Defaults when no preferences row exists: `{ inApp: true, email: true, push: true }`.
 */
export async function getChannelPreferences(
  db: Database,
  userId: string,
  category: string,
): Promise<ChannelPreferences> {
  const [prefs] = await db
    .select()
    .from(schema.notificationPreferences)
    .where(eq(schema.notificationPreferences.userId, userId))
    .limit(1);

  if (!prefs) {
    return { inApp: true, email: true, push: true };
  }

  if (prefs.doNotDisturb) {
    return { inApp: false, email: false, push: false };
  }

  const modulePrefs = prefs.modulePreferences as ModulePreferencesMap | null;
  if (modulePrefs) {
    const moduleKey = category as keyof ModulePreferencesMap;
    const modulePref = modulePrefs[moduleKey];
    if (modulePref) {
      if (!modulePref.enabled) {
        return { inApp: false, email: false, push: false };
      }
      return {
        inApp: modulePref.inApp,
        email: modulePref.email,
        push: modulePref.push,
      };
    }
  }

  return {
    inApp: prefs.defaultInApp,
    email: prefs.defaultEmail,
    push: prefs.defaultPush,
  };
}
