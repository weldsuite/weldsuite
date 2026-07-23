/**
 * Shared types for workspace sample data seeding.
 *
 * Uses NeonHttpDatabase for Cloudflare Workers compatibility.
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@weldsuite/db/schema';

export interface SeedContext {
  generateId: (prefix: string) => string;
  /** Workspace creator's Clerk userId — used for ownerId, assigneeId, authorId, etc. */
  userId: string;
  /** Creator's display name */
  userName?: string;
}

export type DrizzleDb = NeonHttpDatabase<typeof schema>;

export interface SeedResult {
  seeded: string[];
  skipped: string[];
  errors: string[];
}
