/**
 * Entity-linked chat channels ("record chats").
 *
 * The provider registry (one provider per record type: who may see the record,
 * its display name and default followers) lives in
 * `@weldsuite/chat-domain/entity-channels`, so `canAccessChannel` can use it
 * in every worker. Creating channels, following and the record chat lists stay
 * here in chat-api.
 */

export * from '@weldsuite/chat-domain/entity-channels';
export * from './get-or-create-channel';
export * from './followers';
