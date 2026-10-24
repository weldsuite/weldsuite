/**
 * Wire types for helpdesk-widget-api. Mirrors `PublicDeskMessage` /
 * `PublicDeskConversation` in `@weldsuite/db/lib/desk` — keep in sync.
 */

export interface TeamMember {
  name: string;
  avatar: string | null;
}

export interface WidgetConfigResponse {
  widgetId: string;
  name: string | null;
  enabled: boolean;
  greeting: string;
  branding: {
    primaryColor: string;
    backgroundColor: string;
    position: 'right' | 'left';
  };
  showBranding: boolean;
  /** wss:// origin of realtime-worker; null when the API doesn't advertise one. */
  realtimeUrl: string | null;
  team: TeamMember[];
  /** Office hours, computed by the API in the widget's timezone. Missing on older APIs. */
  availability?: {
    isOpen: boolean;
    /** When the team is next in (ISO), while they're away. */
    nextOpenAt: string | null;
  };
  /** The team's own away text; the widget has a default. */
  awayMessage?: string | null;
  expectedReplyTime?: ExpectedReplyTime | null;
}

export type ExpectedReplyTime = 'few_minutes' | 'hour' | 'few_hours' | 'day';

export type AuthorType = 'visitor' | 'agent' | 'bot' | 'system';

export interface MessageAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface PublicMessage {
  id: string;
  conversationId: string;
  kind: 'message' | 'event';
  body: string | null;
  authorType: AuthorType;
  authorName: string | null;
  authorAvatar: string | null;
  attachments: MessageAttachment[] | null;
  eventType: string | null;
  clientId: string | null;
  createdAt: string;
}

export interface PublicConversation {
  id: string;
  conversationNumber: number;
  title: string | null;
  state: 'open' | 'closed';
  createdAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromTeam: boolean;
  assignee: TeamMember | null;
  /** The visitor's 1–5 rating once given; only a closed conversation can be rated. */
  rating: number | null;
}

/** A message as the widget holds it: server copy or optimistic local send. */
export interface ThreadMessage extends PublicMessage {
  status?: 'sending' | 'failed';
}
