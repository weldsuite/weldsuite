// Types
export type {
  ConnectionState,
  WorkspaceEvent,
  RoomEvent,
  RoomMessage,
  PresenceMember,
  TypingUser,
  Attachment,
  WorkspaceClientMessage,
  WorkspaceServerMessage,
  CallSupersededEvent,
  ConversationClientMessage,
  ConversationServerMessage,
  ChatClientMessage,
  ChatServerMessage,
} from './types';

// Topics
export {
  topics,
  topicMatches,
  personalHubKey,
  isPersonalHubKey,
  isBarePersonalTopic,
  PERSONAL_HUB_PREFIX,
} from './topics';

// Presence
export {
  PRESENCE_TOPIC,
  PRESENCE_EVENTS,
  aggregateConnections,
  effectivePresence,
  storedStatusFor,
  chosenStatusFromStored,
  isStatusExpired,
  type LivePresence,
  type ChosenStatus,
  type EffectiveStatus,
  type ConnectionPresence,
  type PresenceSnapshot,
  type PresenceConnectionChange,
  type PresenceStatusChange,
} from './presence';

// Client
export { WorkspaceClient, type WorkspaceClientConfig, type CursorStore } from './client/workspace-client';
export { RoomClient, type RoomClientConfig } from './client/room-client';

// Server
export {
  RealtimePublisher,
  REALTIME_INTERNAL_SECRET_HEADER,
  type RealtimePublisherOptions,
} from './server';

// React
export {
  RealtimeProvider,
  useWorkspaceClient,
  useTopic,
  useRealtimeEvent,
  useRealtimeConnection,
  useConversation,
  useChatRoom,
  useRoomPresence,
  useRoomTyping,
} from './react/index';
