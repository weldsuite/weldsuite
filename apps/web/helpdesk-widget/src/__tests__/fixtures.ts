/** Test data for the messenger's components: a widget config, a Messenger, threads. */
import { vi } from 'vitest';
import type { Messenger } from '@/hooks/use-messenger';
import type { PublicConversation, TeamMember, ThreadMessage, WidgetConfigResponse } from '@/lib/api/types';

export const SOPHIE: TeamMember = { name: 'Sophie Bakker', avatar: null };
export const DAAN: TeamMember = { name: 'Daan de Vries', avatar: null };

export function widgetConfig(overrides: Partial<WidgetConfigResponse> = {}): WidgetConfigResponse {
  return {
    widgetId: 'wdg_test',
    name: 'Acme Support',
    enabled: true,
    greeting: 'How can we help?',
    branding: { primaryColor: '#4f46e5', backgroundColor: '#ffffff', position: 'right' },
    showBranding: false,
    realtimeUrl: null,
    team: [SOPHIE, DAAN],
    availability: { isOpen: true, nextOpenAt: null },
    awayMessage: null,
    expectedReplyTime: 'few_minutes',
    ...overrides,
  };
}

/** Every field of the Messenger, with inert callbacks; pass what a test cares about. */
export function fakeMessenger(overrides: Partial<Messenger> = {}): Messenger {
  return {
    status: 'ready',
    visitorId: 'vis_test',
    verified: false,
    profile: { name: 'Alex Morgan', email: 'alex@example.com' },
    identify: vi.fn(),
    conversations: [],
    conversationsLoaded: true,
    refreshConversations: vi.fn(),
    threads: {},
    loadingThread: null,
    typing: {},
    isUnread: vi.fn(() => false),
    unreadCount: 0,
    send: vi.fn(),
    rate: vi.fn(),
    uploadAttachment: vi.fn(),
    retry: vi.fn(),
    notifyTyping: vi.fn(),
    stopTyping: vi.fn(),
    ...overrides,
  };
}

let sequence = 0;

/** A message (or, with `kind: 'event'`, an event) in conversation `conv_test`. */
export function threadMessage(
  fields: Partial<ThreadMessage> & Pick<ThreadMessage, 'authorType' | 'createdAt'>,
): ThreadMessage {
  sequence += 1;
  return {
    id: `msg_${sequence}`,
    conversationId: 'conv_test',
    kind: 'message',
    body: `Message ${sequence}`,
    authorName: null,
    authorAvatar: null,
    attachments: null,
    eventType: null,
    clientId: null,
    ...fields,
  };
}

export function conversation(overrides: Partial<PublicConversation> = {}): PublicConversation {
  return {
    id: 'conv_test',
    conversationNumber: 1042,
    title: 'Export to PDF',
    state: 'open',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: 'Did the email come through?',
    lastMessageFromTeam: true,
    assignee: SOPHIE,
    rating: null,
    ...overrides,
  };
}

/** An ISO time `minutes` before `now`. */
export function minutesAgo(minutes: number, now: number = Date.now()): string {
  return new Date(now - minutes * 60_000).toISOString();
}
