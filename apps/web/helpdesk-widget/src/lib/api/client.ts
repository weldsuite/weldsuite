/**
 * Widget API Client
 *
 * All widget operations go through the dedicated Widget API (helpdesk-widget-api).
 */

import type {
  WidgetSettings,
  ApiResponse,
  StartConversationRequest,
  StartConversationResponse,
  SendCustomerMessageRequest,
  SendCustomerMessageResponse,
  WidgetConfigResponse,
  AgentOnlineResponse,
  RateConversationRequest,
  RateConversationResponse,
  ConversationMessage,
  MessageAttachment,
  InlineWelcomeMessage,
  OpenRequest,
  OpenResponse,
} from './types';
import { getCustomerProfile, saveCustomerProfile } from '../utils/customer-storage';

// Re-export types for backward compatibility
export type { MessageAttachment };

export interface Conversation {
  id: string;
  conversationNumber: string;
  subject: string;
  status: string;
  customerName?: string;
  customerEmail?: string;
  assigneeName?: string;
  messageCount?: number;
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  content: string;
  authorName: string;
  authorEmail?: string;
  authorType: 'customer' | 'agent' | 'system';
  authorAvatar?: string;
  createdAt: string;
  isRead?: boolean;
  attachments?: MessageAttachment[];
}

export interface CreateConversationParams {
  widgetId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerCompany?: string;
  subject?: string;
  initialMessage?: string;
  customerId?: string;
  visitorId?: string;
  metadata?: Record<string, unknown>;
  website?: string;
  /** Welcome preview messages to persist (bot prompts + customer form responses) */
  welcomeMessages?: Array<{ content: string; sender: 'agent' | 'customer'; senderName?: string; metadata?: Record<string, unknown> }>;
}

export interface SendMessageParams {
  content: string;
  authorName: string;
  authorEmail?: string;
  authorType?: 'customer' | 'agent';
  attachments?: MessageAttachment[];
}

class WidgetApiClient {
  private apiUrl: string;
  private widgetId: string | null = null;
  private customerId: string | null = null;
  private _testMode = false;

  constructor() {
    // Use Vite environment variable
    this.apiUrl = import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
  }

  /**
   * Configure the client with widget ID
   * Restores customerId from localStorage if available
   */
  configure(config: { widgetId: string; customerId?: string }) {
    this.widgetId = config.widgetId;
    if (config.customerId) {
      this.customerId = config.customerId;
    } else {
      // Restore customerId from persisted customer profile
      const profile = getCustomerProfile(config.widgetId);
      if (profile?.customerId) {
        this.customerId = profile.customerId;
      }
    }
  }

  /**
   * Set the widget ID for API calls
   */
  setWidgetId(widgetId: string) {
    this.widgetId = widgetId;
  }

  /**
   * Get the base URL for direct fetch calls (e.g., SSE streams)
   */
  getBaseUrl(): string {
    return this.apiUrl;
  }

  /**
   * Get the widget ID for direct fetch calls (e.g., SSE streams)
   */
  getWidgetId(): string {
    return this.widgetId || '';
  }

  /**
   * Set the customer ID for API calls
   */
  setCustomerId(customerId: string) {
    this.customerId = customerId;
  }

  /**
   * Enable test mode — API calls that create/send data return mocks instead
   */
  setTestMode(enabled: boolean) {
    this._testMode = enabled;
  }

  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'x-widget-id': this.widgetId || '',
    };
  }

  /**
   * Base fetch method with error handling, 15s timeout, and retry for GET requests.
   */
  private async fetch<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<ApiResponse<T>> {
    const method = options?.method?.toUpperCase() || 'GET';
    const maxAttempts = method === 'GET' ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);

      try {
        const url = `${this.apiUrl}${endpoint}`;

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.getHeaders(),
            ...options?.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // Retry on 5xx for GET requests
          if (response.status >= 500 && attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const errorData = await response.json().catch(() => ({}));
          console.error(`[Widget API] Error ${response.status}:`, errorData);
          return {
            success: false,
            error: {
              code: `HTTP_${response.status}`,
              message: errorData.error?.message || errorData.error || errorData.message || `HTTP error ${response.status}`,
              details: errorData,
            },
          };
        }

        const data = await response.json();
        // Widget API returns { success: true, data: ... }
        if (data.success !== undefined) {
          return data;
        }
        return {
          success: true,
          data,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        // Retry on network/timeout errors for GET requests
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        const isTimeout = error instanceof DOMException && error.name === 'AbortError';
        console.error(`[Widget API] ${isTimeout ? 'Timeout' : 'Network error'}:`, error);
        return {
          success: false,
          error: {
            code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
            message: isTimeout
              ? 'Request timed out'
              : error instanceof Error ? error.message : 'Network request failed',
            details: error,
          },
        };
      }
    }

    // Should never reach here, but TypeScript needs it
    return { success: false, error: { code: 'UNKNOWN', message: 'Unexpected error' } };
  }

  // ============================================
  // Open (single-request initialization)
  // ============================================

  /**
   * Initialize the widget in a single request.
   * Returns config, welcome workflow, team, contact, conversations, unread count.
   * Uses Widget API: POST /api/open
   */
  async open(params: OpenRequest): Promise<ApiResponse<OpenResponse>> {
    return this.fetch<OpenResponse>('/api/open', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // ============================================
  // Widget Settings
  // ============================================

  /**
   * Get widget settings/configuration
   * Uses Widget API: GET /api/config
   */
  async getWidgetSettings(widgetId?: string): Promise<ApiResponse<WidgetSettings>> {
    const id = widgetId || this.widgetId;

    if (!id) {
      return {
        success: false,
        error: {
          code: 'MISSING_WIDGET_ID',
          message: 'Widget ID is required',
        },
      };
    }

    // Temporarily set widget ID for the request
    const prevWidgetId = this.widgetId;
    this.widgetId = id;

    const result = await this.fetch<Record<string, unknown>>('/api/config');

    // Restore previous widget ID
    this.widgetId = prevWidgetId;

    if (!result.success) {
      return result as unknown as ApiResponse<WidgetSettings>;
    }

    // Transform widget API response to WidgetSettings format
    const config = result.data as Record<string, unknown>;
    const colors = config?.colors as Record<string, string> | undefined;
    const styling = config?.styling as Record<string, string> | undefined;
    const pages = config?.pages as Record<string, boolean> | undefined;
    const behavior = config?.behavior as Record<string, unknown> | undefined;
    const branding = config?.branding as Record<string, unknown> | undefined;
    const chat = config?.chat as Record<string, string> | undefined;
    const availability = config?.availability as Record<string, unknown> | undefined;

    const settings: WidgetSettings = {
      id: (config?.widgetId as string) || id,
      name: (config?.widgetName as string) || 'Widget',
      themeSettings: {
        colorPrimary: colors?.primary || '#4169E1',
        colorButton: colors?.button || '#4169E1',
        colorButtonText: colors?.buttonText || '#FFFFFF',
        colorLauncher: colors?.launcher || '#000000',
        colorHeader: colors?.header || '#FFFFFF',
        colorAccent: colors?.accent || '#4169E1',
        borderRadius: parseInt(styling?.borderRadius || '20') || 20,
        fontSize: parseInt(styling?.fontSize || '14') || 14,
        typographyText: styling?.typographyText || '#000000',
        typographyBackground: styling?.typographyBackground || '#FFFFFF',
      },
      pageHome: pages?.home ?? true,
      pageChat: pages?.chat ?? true,
      pageHelp: pages?.help ?? true,
      pageParcelTracking: pages?.parcelTracking ?? false,
      pageChangelog: pages?.changelog ?? false,
      pageNews: pages?.news ?? false,
      pageFeedback: pages?.feedback ?? false,
      pageAnnouncements: pages?.announcements ?? false,
      pageEventSignUp: pages?.eventSignUp ?? false,
      typographyText: styling?.typographyText || '#000000',
      typographyBackground: styling?.typographyBackground || '#FFFFFF',
      startingPage: (behavior?.startingPage as string) || 'Home',
      position: (behavior?.position as string) || 'bottom-right',
      autoOpen: (behavior?.autoOpen as boolean) ?? false,
      companyLogoUrl: branding?.companyLogoUrl as string | undefined,
      showBranding: (branding?.showBranding as boolean) ?? true,
      // Chat colors
      chatBackgroundColor: chat?.backgroundColor,
      userBubbleColor: chat?.userBubbleColor,
      userBubbleTextColor: chat?.userBubbleTextColor,
      agentBubbleColor: chat?.agentBubbleColor,
      agentBubbleTextColor: chat?.agentBubbleTextColor,
      // Availability
      replyTimeText: (availability?.replyTimeText as string) || undefined,
      isWithinOfficeHours: (availability?.isWithinOfficeHours as boolean) ?? undefined,
      nextOpenTime: (availability?.nextOpenTime as string) || null,
      officeHoursTimezone: (availability?.officeHoursTimezone as string) || null,
      officeHours: (availability?.officeHours as Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }>) || null,
      // Welcome workflow steps
      welcomeFlow: (config?.welcomeFlow as WidgetSettings['welcomeFlow']) || null,
      // Bot agent info from WeldAgent settings
      botAgent: (config?.botAgent as WidgetSettings['botAgent']) || null,
    };

    return { success: true, data: settings };
  }

  /**
   * Get default widget settings (fallback when API is not available)
   */
  getDefaultSettings(): WidgetSettings {
    return {
      id: 'default',
      name: 'Default Widget',
      themeSettings: {
        colorPrimary: '#4169E1',
        colorButton: '#4169E1',
        colorButtonText: '#FFFFFF',
        colorLauncher: '#000000',
        colorHeader: '#FFFFFF',
        colorAccent: '#4169E1',
        borderRadius: 20,
        fontSize: 14,
        typographyText: '#000000',
        typographyBackground: '#FFFFFF',
      },
      pageHome: true,
      pageChat: true,
      pageHelp: true,
      pageParcelTracking: false,
      pageChangelog: false,
      pageNews: false,
      pageFeedback: false,
      pageAnnouncements: false,
      pageEventSignUp: false,
      typographyText: '#000000',
      typographyBackground: '#FFFFFF',
      startingPage: 'Home',
      position: 'bottom-right',
      autoOpen: false,
    };
  }

  // ============================================
  // Conversation Management
  // ============================================

  /**
   * Create a new conversation
   * Uses Widget API: POST /api/conversations
   */
  async createConversation(params: CreateConversationParams): Promise<{
    success: boolean;
    conversation?: { id: string; conversationNumber: string; status: string; createdAt: string; customerId?: string; contactId?: string; useWorkflowStream?: boolean };
    /** Welcome messages persisted in DB and returned inline (Intercom pattern) */
    messages?: InlineWelcomeMessage[];
    error?: string;
  }> {
    if (this._testMode) {
      const mockId = `test_conv_${Date.now()}`;
      return {
        success: true,
        conversation: {
          id: mockId,
          conversationNumber: 'TEST-001',
          status: 'open',
          createdAt: new Date().toISOString(),
          customerId: `test_cust_${Date.now()}`,
        },
        messages: [],
      };
    }

    const result = await this.fetch<Record<string, unknown>>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: params.subject || 'New conversation',
        customerEmail: params.customerEmail,
        customerName: params.customerName,
        customerId: params.customerId || this.customerId,
        visitorId: params.visitorId,
        initialMessage: params.initialMessage,
        website: params.website,
        welcomeMessages: params.welcomeMessages,
      }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to create conversation' };
    }

    // Persist customerId to memory and localStorage for future sessions
    if (result.data?.customerId) {
      this.customerId = result.data.customerId as string;
      if (this.widgetId) {
        const profile = getCustomerProfile(this.widgetId);
        saveCustomerProfile(this.widgetId, {
          ...profile,
          customerId: this.customerId,
          email: params.customerEmail || profile?.email,
          visitorId: params.visitorId || profile?.visitorId,
          name: params.customerName || profile?.name,
        });
      }
    }

    return {
      success: true,
      conversation: result.data as { id: string; conversationNumber: string; status: string; createdAt: string; customerId?: string; contactId?: string; useWorkflowStream?: boolean },
      messages: (result.data?.messages as InlineWelcomeMessage[]) || [],
    };
  }

  /**
   * Get conversation details
   * Uses Widget API: GET /api/conversations/:id
   */
  async getConversation(conversationId: string): Promise<{
    success: boolean;
    conversation?: Conversation;
    error?: string;
  }> {
    const result = await this.fetch<Conversation>(`/api/conversations/${conversationId}`);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get conversation' };
    }

    return {
      success: true,
      conversation: result.data,
    };
  }

  /**
   * Bulk fetch conversations by IDs.
   * Returns conversation summaries with current status.
   */
  async getConversationsBulk(conversationIds: string[]): Promise<{
    success: boolean;
    conversations: Array<{ id: string; status: string; subject?: string; lastMessage?: string; lastMessageAt?: string | null; createdAt?: string | null }>;
  }> {
    if (conversationIds.length === 0) return { success: true, conversations: [] };

    const result = await this.fetch<Array<{ id: string; status: string; subject?: string; lastMessage?: string; lastMessageAt?: string | null; createdAt?: string | null }>>(
      '/api/conversations/bulk',
      { method: 'POST', body: JSON.stringify({ conversationIds }) },
    );

    return { success: result.success, conversations: result.data || [] };
  }

  /**
   * Get customer's conversations by contactId
   * Uses Widget API: GET /api/conversations/contact/:contactId
   * Falls back to legacy customer/:customerId endpoint
   */
  async getConversations(params: {
    customerEmail?: string;
    customerId?: string;
    contactId?: string;
  }): Promise<{
    success: boolean;
    conversations?: Conversation[];
    error?: string;
  }> {
    if (this._testMode) {
      return { success: true, conversations: [] };
    }

    // Prefer contactId-based lookup (works across sessions)
    const contactId = params.contactId;
    if (contactId) {
      const result = await this.fetch<Conversation[]>(`/api/conversations/contact/${contactId}`);
      if (result.success) {
        return { success: true, conversations: result.data || [] };
      }
    }

    // Fall back to customerId-based lookup
    const customerId = params.customerId || this.customerId;
    if (!customerId) {
      return { success: false, error: 'Customer ID is required', conversations: [] };
    }

    const result = await this.fetch<Conversation[]>(`/api/conversations/customer/${customerId}`);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get conversations', conversations: [] };
    }

    return {
      success: true,
      conversations: result.data || [],
    };
  }

  /**
   * Resolve a contact ID from visitorId or email
   * Uses Widget API: GET /api/conversations/resolve-contact
   */
  async resolveContact(params: {
    visitorId?: string;
    email?: string;
  }): Promise<{ contactId: string | null }> {
    const queryParams = new URLSearchParams();
    if (params.visitorId) queryParams.set('visitorId', params.visitorId);
    if (params.email) queryParams.set('email', params.email);

    const result = await this.fetch<{ contactId: string | null }>(
      `/api/conversations/resolve-contact?${queryParams.toString()}`
    );

    if (!result.success || !result.data) {
      return { contactId: null };
    }

    return { contactId: result.data.contactId };
  }

  /**
   * Close a conversation
   * Uses Widget API: PATCH /api/conversations/:id
   */
  async closeConversation(conversationId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const result = await this.fetch<unknown>(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to close conversation' };
    }

    return { success: true };
  }

  /**
   * Update the customer email for a conversation and its linked contact
   * Uses Widget API: PATCH /api/conversations/:id/customer-email
   */
  async updateCustomerEmail(conversationId: string, email: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const result = await this.fetch<any>(`/api/conversations/${conversationId}/customer-email`, {
      method: 'PATCH',
      body: JSON.stringify({ email }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to update customer email' };
    }

    return { success: true };
  }

  /**
   * Send typing indicator
   * Uses Widget API: POST /api/conversations/:id/typing
   */
  async sendTypingIndicator(
    conversationId: string,
    params: { authorName: string; authorType: 'customer' | 'agent'; isTyping: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    if (this._testMode) {
      return { success: true };
    }

    const result = await this.fetch<unknown>(`/api/conversations/${conversationId}/typing`, {
      method: 'POST',
      body: JSON.stringify({
        isTyping: params.isTyping,
        customerName: params.authorName,
      }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to send typing indicator' };
    }

    return { success: true };
  }

  /**
   * Rate a conversation
   * Uses Widget API: POST /api/conversations/:id/rate
   */
  async rateConversation(
    conversationId: string,
    data: RateConversationRequest
  ): Promise<RateConversationResponse> {
    const result = await this.fetch<unknown>(`/api/conversations/${conversationId}/rate`, {
      method: 'POST',
      body: JSON.stringify({
        rating: data.rating,
        feedback: data.comment,
      }),
    });

    return {
      success: result.success,
      data: result.success ? { rated: true } : undefined,
      error: result.error,
    };
  }

  // ============================================
  // Messages
  // ============================================

  /**
   * Get unread message count across conversations
   * Uses Widget API: GET /api/messages/unread-count
   */
  /**
   * Get a JWT token for the realtime WebSocket connection.
   * Uses Widget API: POST /api/realtime/token
   */
  async getRealtimeToken(customerId?: string, conversationId?: string): Promise<string> {
    const result = await this.fetch<{ token: string; unreadCount: number }>(
      '/api/realtime/token',
      {
        method: 'POST',
        body: JSON.stringify({ customerId: customerId || undefined, conversationId: conversationId || undefined }),
      }
    );
    return result.success ? (result.data?.token || '') : '';
  }

  async getUnreadCount(conversationIds: string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    const result = await this.fetch<{ count: number }>(
      `/api/messages/unread-count?conversationIds=${conversationIds.join(',')}`
    );
    return result.success ? (result.data?.count || 0) : 0;
  }

  /**
   * Get messages for a conversation
   * Uses Widget API: GET /api/messages/:conversationId
   */
  async getMessages(conversationId: string): Promise<{
    success: boolean;
    messages?: Message[];
    error?: string;
  }> {
    if (this._testMode) {
      return { success: true, messages: [] };
    }

    const result = await this.fetch<Message[]>(`/api/messages/${conversationId}`);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get messages', messages: [] };
    }

    return {
      success: true,
      messages: result.data || [],
    };
  }

  /**
   * Send a message
   * Uses Widget API: POST /api/messages/:conversationId
   */
  async sendMessage(
    conversationId: string,
    params: SendMessageParams
  ): Promise<{
    success: boolean;
    message?: Message;
    error?: string;
  }> {
    if (this._testMode) {
      return {
        success: true,
        message: {
          id: `test_msg_${Date.now()}`,
          content: params.content,
          authorName: params.authorName,
          authorEmail: params.authorEmail,
          authorType: params.authorType || 'customer',
          createdAt: new Date().toISOString(),
        },
      };
    }

    const result = await this.fetch<Message>(`/api/messages/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: params.content,
        customerName: params.authorName,
        customerEmail: params.authorEmail,
        attachments: params.attachments,
      }),
    });


    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to send message' };
    }

    return {
      success: true,
      message: result.data,
    };
  }

  /**
   * Respond to an interactive workflow message (choices or input form)
   * Uses Widget API: POST /api/messages/:messageId/respond
   */
  async respondToMessage(
    messageId: string,
    response: { type: 'choice'; optionId: string; value: string } | { type: 'input'; data: Record<string, string> } | { type: 'csat'; rating: number; feedback?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.fetch<{ success: boolean }>(`/api/messages/${messageId}/respond`, {
      method: 'POST',
      body: JSON.stringify(response),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to respond' };
    }

    return { success: true };
  }

  // ============================================
  // Workflows
  // ============================================

  /**
   * Trigger a workflow on a conversation via SSE streaming.
   * AI tokens arrive as SSE events; all messages are persisted to DB.
   * The onEvent callback receives step events (ai_token, ai_complete, etc.).
   */
  async triggerWorkflow(
    conversationId: string,
    trigger: string,
    data?: Record<string, unknown>,
    onEvent?: (event: string, data: Record<string, unknown>) => void,
  ): Promise<{ success: boolean }> {
    const url = `${this.apiUrl}/api/conversations/${conversationId}/workflow-stream?trigger=${trigger}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Accept': onEvent ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(data || {}),
      });

      if (!response.ok) return { success: false };

      // If SSE streaming with callback
      if (onEvent && response.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';

            for (const part of parts) {
              const eventMatch = part.match(/^event: (.+)$/m);
              const dataMatch = part.match(/^data: (.+)$/m);
              if (eventMatch && dataMatch) {
                try {
                  onEvent(eventMatch[1], JSON.parse(dataMatch[1]));
                } catch {}
              }
            }
          }
        }
        return { success: true };
      }

      // JSON mode
      const result = await response.json();
      return { success: result.success ?? true };
    } catch {
      return { success: false };
    }
  }

  // ============================================
  // Agents
  // ============================================

  /**
   * Check if agents are online
   * Uses Widget API: GET /api/agents/status
   */
  async checkAgentsOnline(): Promise<AgentOnlineResponse> {
    const result = await this.fetch<AgentOnlineResponse['data']>('/api/agents/status');

    return {
      success: result.success,
      data: result.data,
      error: result.error,
    };
  }

  // ============================================
  // Attachments
  // ============================================

  /**
   * Upload a file attachment
   *
   * Uploads the file via the widget API which stores it in R2.
   */
  async uploadAttachment(
    file: File,
    conversationId?: string
  ): Promise<{
    success: boolean;
    attachment?: MessageAttachment;
    error?: string;
  }> {
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (conversationId) {
        formData.append('conversationId', conversationId);
      }

      const url = `${this.apiUrl}/api/attachments/upload`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-widget-id': this.widgetId || '',
          // Note: Don't set Content-Type for FormData - browser sets it with boundary
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error(`[Widget API] Upload error ${response.status}:`, errorData);
        return {
          success: false,
          error: errorData.error?.message || errorData.error || 'Upload failed',
        };
      }

      const data = await response.json();

      return {
        success: true,
        attachment: data.data,
      };
    } catch (err) {
      console.error('[Widget API] Upload error:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Upload failed',
      };
    }
  }

  // ============================================
  // ============================================
  // Legacy API Methods (for backward compatibility)
  // ============================================

  /**
   * Start a new conversation with the helpdesk
   */
  async startConversation(data: StartConversationRequest): Promise<StartConversationResponse> {
    const result = await this.createConversation({
      widgetId: this.widgetId || '',
      customerName: data.name || 'Guest',
      customerEmail: data.email || undefined,
      subject: data.subject,
      initialMessage: data.message,
    });

    return {
      success: result.success,
      data: result.conversation ? {
        id: result.conversation.id,
        conversationNumber: parseInt(result.conversation.conversationNumber?.replace('CONV-', '') || '0'),
        status: result.conversation.status,
        priority: 'normal',
        channel: 'chat',
        customerId: result.conversation.customerId,
        createdAt: result.conversation.createdAt,
      } : undefined,
      error: result.error ? { code: 'ERROR', message: result.error } : undefined,
    };
  }

  /**
   * Send a message in a conversation (legacy method name)
   */
  async sendCustomerMessage(
    conversationId: string,
    data: SendCustomerMessageRequest
  ): Promise<SendCustomerMessageResponse> {
    const result = await this.sendMessage(conversationId, {
      content: data.content,
      authorName: 'Customer',
      authorType: 'customer',
    });

    return {
      success: result.success,
      data: result.message as ConversationMessage | undefined,
      error: result.error ? { code: 'ERROR', message: result.error } : undefined,
    };
  }

  /**
   * Get conversation history (legacy method name)
   */
  async getConversationHistory(conversationId: string, widgetId?: string): Promise<ApiResponse<Message[]>> {
    if (widgetId) this.widgetId = widgetId;
    const result = await this.getMessages(conversationId);
    return {
      success: result.success,
      data: result.messages,
      error: result.error ? { code: 'ERROR', message: result.error } : undefined,
    };
  }

  /**
   * Get widget configuration
   */
  async getWidgetConfig(): Promise<WidgetConfigResponse> {
    const result = await this.getWidgetSettings();
    return {
      success: result.success,
      data: result.data as WidgetConfigResponse['data'],
      error: result.error,
    };
  }

  /**
   * Submit a review for a conversation
   */
  async submitReview(
    conversationId: string,
    data: { rating: number; feedback?: string }
  ): Promise<ApiResponse<{ reviewId: string; rating: number; message: string }>> {
    const result = await this.rateConversation(conversationId, {
      rating: data.rating,
      comment: data.feedback,
    });

    return {
      success: result.success,
      data: result.success ? {
        reviewId: conversationId,
        rating: data.rating,
        message: 'Thank you for your feedback!',
      } : undefined,
      error: result.error,
    };
  }
}

// Export singleton instance
export const platformApi = new WidgetApiClient();

// Export class for testing
export { WidgetApiClient };
