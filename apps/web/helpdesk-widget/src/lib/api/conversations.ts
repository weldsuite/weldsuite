/**
 * Client-side conversation API functions
 * Converted from server actions to direct client-side fetch calls
 */

import type { Message } from './types';

// Widget API URL - all widget operations go through the dedicated Widget API
const getApiUrl = () => import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';

export interface FetchMessagesResult {
  success: boolean;
  messages?: Message[];
  error?: string;
}

/**
 * Fetch conversation messages from the Widget API
 */
export async function fetchConversationMessages(
  conversationId: string,
  widgetId: string,
  after?: string,
): Promise<FetchMessagesResult> {
  try {
    let url = `${getApiUrl()}/api/messages/${conversationId}`;
    if (after) {
      url += `?after=${encodeURIComponent(after)}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-widget-id': widgetId,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error?.message || errorData.error || errorData.message || `HTTP error ${response.status}`,
      };
    }

    const data = await response.json();

    if (!data.success) {
      return {
        success: false,
        error: data.error?.message || data.error || 'Failed to fetch messages',
      };
    }

    // Transform the response to match the Message type
    // Widget API returns data directly, not wrapped in { messages: [...] }
    const rawMessages = Array.isArray(data.data) ? data.data : (data.messages || []);
    const messages: Message[] = rawMessages.map((msg: Record<string, unknown>) => {
      // Transform attachments - handle both naming conventions
      const rawAttachments = msg.attachments as Array<Record<string, unknown>> | undefined;
      const attachments = rawAttachments?.map((att) => ({
        id: att.id as string,
        name: (att.fileName || att.name) as string,
        fileName: (att.fileName || att.name) as string,
        mimeType: (att.mimeType || att.type) as string,
        fileSize: (att.fileSize || att.size) as number,
        size: String(att.fileSize || att.size || 0),
        url: att.url as string,
      }));

      const isSystem = msg.authorType === 'system' || msg.type === 'system';
      const rawMetadata = (msg.metadata as Record<string, unknown> | undefined) || {};

      return {
        id: msg.id as string,
        conversationId: (msg.conversationId as string) || conversationId,
        content: msg.content as string,
        sender: (msg.authorType === 'customer' ? 'user' : 'agent') as 'user' | 'agent',
        timestamp: new Date(msg.createdAt as string),
        senderName: msg.authorName as string | undefined,
        senderId: msg.authorId as string | undefined,
        attachments,
        metadata: isSystem ? { ...rawMetadata, systemEvent: true } : rawMetadata,
      };
    });

    return {
      success: true,
      messages,
    };
  } catch (error) {
    console.error('Failed to fetch conversation messages:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch messages',
    };
  }
}

export interface ConversationDetails {
  id: string;
  conversationNumber: string;
  subject: string;
  status: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  messageCount: number;
  customerName: string;
  customerEmail: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeAvatar: string | null;
  ticketId?: string | null;
  ticketNumber?: string | null;
  ticketStatus?: string | null;
  ticketSubject?: string | null;
}

export interface FetchConversationResult {
  success: boolean;
  conversation?: ConversationDetails;
  error?: string;
}

/**
 * Fetch a single conversation by ID
 * The conversation ID acts as an access token - only those who know it can access it
 */
export async function fetchConversation(
  conversationId: string,
  widgetId: string
): Promise<FetchConversationResult> {
  try {
    const url = `${getApiUrl()}/api/conversations/${conversationId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-widget-id': widgetId,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error?.message || errorData.error || errorData.message || `HTTP error ${response.status}`,
      };
    }

    const data = await response.json();

    if (!data.success) {
      return {
        success: false,
        error: data.error?.message || data.error || 'Failed to fetch conversation',
      };
    }

    // Widget API returns data directly
    return {
      success: true,
      conversation: data.data,
    };
  } catch (error) {
    console.error('Failed to fetch conversation:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch conversation',
    };
  }
}

export interface SubmitReviewResult {
  success: boolean;
  reviewId?: string;
  error?: string;
}

/**
 * Submit a review for a conversation
 */
export async function submitConversationReview(
  conversationId: string,
  widgetId: string,
  rating: number,
  feedback?: string
): Promise<SubmitReviewResult> {
  try {
    const url = `${getApiUrl()}/api/conversations/${conversationId}/rate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-widget-id': widgetId,
      },
      body: JSON.stringify({
        rating,
        feedback,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Review submission failed:', response.status, errorData);
      return {
        success: false,
        error: errorData.error?.message || errorData.message || `HTTP error ${response.status}`,
      };
    }

    const data = await response.json();

    return {
      success: true,
      reviewId: data.data?.conversationId || conversationId,
    };
  } catch (error) {
    console.error('Failed to submit review:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to submit review',
    };
  }
}
