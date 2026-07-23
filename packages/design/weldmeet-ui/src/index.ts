// Shared types
export type { ViewMode, RecordingState, MeetingRoomViewProps } from './types';

// Chat
export {
  SharedMeetingChatPanel,
  type SharedMeetingChatPanelProps,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatParticipant,
  type PinnedMessage,
} from './components/meeting-chat-panel';
export {
  MeetingChatNotification,
  type MeetingChatNotificationProps,
} from './components/meeting-chat-notification';

// Components
export { ParticipantTile, ScreenShareTile, useIsSpeaking, getPersonTheme, getInitials, type ParticipantTileProps, type ScreenShareTileProps } from './components/participant-tile';
export { ParticipantContextMenu, type ParticipantContextMenuProps } from './components/participant-context-menu';
export { CallControlsBar, type CallControlsBarProps } from './components/call-controls-bar';
export { MeetingRoomView } from './components/meeting-room-view';
export { MeetingHeader } from './components/meeting-header';
export { MeetingRightPanel, type RightPanelKind } from './components/meeting-right-panel';
export { MeetingToolsPanel, type MeetingToolsPanelProps } from './components/meeting-tools-panel';
export { ShareLinkCard } from './components/share-link-card';
export { InvitePopover, type InvitePopoverProps } from './components/invite-popover';
export { PreviewView, type PreviewViewProps } from './components/preview-view';
export { ConnectingView } from './components/connecting-view';
export { PeoplePanel, type PeoplePanelProps } from './components/people-panel';
export { PeopleEntityListPanel, type PeopleEntityListPanelProps } from './components/people-entity-list-panel';

// EntityList — re-exported so platform consumers (via the platform-side shim)
// and the shared people-entity-list-panel both pull from one source of truth.
export { EntityList, FilterPills, EmptyStateIllustration } from './components/entity-list';
export type {
  ColumnDef,
  HeaderColumn,
  FilterConfig,
  FilterOption,
  ActiveFilter,
  GroupConfig,
  RowHandlers,
  EntityListProps,
  FilterPillsProps,
  SortState,
} from './components/entity-list';
export { AdmitGuestsPill, type AdmitGuestsPillProps } from './components/admit-guests-pill';
export { HostControlsPanel, type HostControlsPanelProps, type HostControlsValue } from './components/host-controls-panel';
export { BackgroundEffectsPanel, type BackgroundEffectsPanelProps } from './components/background-effects-panel';
export { ParticipantNameTag, type ParticipantNameTagProps } from './components/participant-name-tag';
export { ParticipantAvatar, type ParticipantAvatarProps } from './components/participant-avatar';

// Hooks
export {
  useVirtualBackground,
  useVirtualBackgroundPreference,
  getStoredBackgroundPreference,
  type VirtualBackgroundType,
  type VirtualBackgroundPreference,
} from './hooks/use-virtual-background';
