/**
 * WeldChat channel-access service — re-exports the shared implementation.
 *
 * Moved to `@weldsuite/chat-domain/channel-access` so connect-api's
 * WeldConnect `post_chat_message` internal route can evaluate the same
 * membership boundary for the workflow's owner without importing across
 * worker folders (workers never import another worker's `src/`). This shim
 * keeps every existing chat-api import path (`'../../services/chat/channel-access'`)
 * working unchanged.
 */

export * from '@weldsuite/chat-domain/channel-access';
