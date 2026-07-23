/**
 * Internal type aliases for the publisher / dispatch modules.
 *
 * Keeps the Drizzle Database generic out of every call signature so
 * downstream changes to schema typing don't ripple through callers.
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@weldsuite/db/schema';

export type TenantDb = NeonHttpDatabase<typeof schema>;
