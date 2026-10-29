/**
 * Moved to `@weldsuite/mail-domain/store/thread-match` (design task A3) so
 * the shared `resolveInbound` logic can run in the mailbox object too. Kept
 * here as a re-export so this worker's existing imports keep compiling
 * unchanged.
 */
export * from '@weldsuite/mail-domain/store/thread-match';
