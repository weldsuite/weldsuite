import { createMobileQueryClient } from '@weldsuite/mobile-realtime';

/**
 * Module-level client so accounting invalidation seeds survive screen remounts.
 */
export const queryClient = createMobileQueryClient({ staleTime: 30_000 });
