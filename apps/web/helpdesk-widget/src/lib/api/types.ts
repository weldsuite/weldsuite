export interface MessageAttachment {
  id?: string;
  name?: string;
  fileName?: string;
  size?: string;
  fileSize?: number;
  mimeType?: string;
  type?: 'image' | 'file';
  url?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: Date;
  senderId?: string;
  senderName?: string;
  attachments?: MessageAttachment[];
  metadata?: Record<string, unknown>;
}

export interface WidgetConfigResponse {
  widgetId: string;
  enabled: boolean;
  greeting: string;
  branding: {
    primaryColor: string;
    backgroundColor: string;
    position: 'right' | 'left';
  };
  showBranding: boolean;
}

export interface DeskApiMessage {
  id: string;
  conversationId: string;
  kind: 'message' | 'note' | 'event';
  body: string | null;
  authorType: 'visitor' | 'agent' | 'bot' | 'system';
  authorId: string | null;
  createdAt: string;
  attachments?: Array<{
    name: string;
    url: string;
    contentType: string;
    filesize: number;
  }> | null;
}

export interface DeskApiConversation {
  id: string;
  conversationNumber: number;
  title: string | null;
  state: 'open' | 'closed';
  visitorId: string | null;
  name: string | null;
  email: string | null;
  messages?: DeskApiMessage[];
}
