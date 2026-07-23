import { z } from 'zod';

// ============================================================================
// Queries
// ============================================================================

export const listDirectoryChannelsQuerySchema = z.object({
  search: z.string().optional(),
});

export type ListDirectoryChannelsQuery = z.infer<typeof listDirectoryChannelsQuerySchema>;

// ============================================================================
// Response Interfaces
// ============================================================================

export interface DirectoryChannelItem {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  isJoined: boolean;
  type: 'public' | 'private';
}
