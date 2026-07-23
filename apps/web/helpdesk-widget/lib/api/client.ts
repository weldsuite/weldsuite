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
  ConversationResponse,
  SendCustomerMessageRequest,
  SendCustomerMessageResponse,
  WidgetConfigResponse,
  AgentOnlineResponse,
  RateConversationRequest,
  RateConversationResponse,
  ConversationMessage,
} from './types';

// Re-export types for backward compatibility
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

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
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
  metadata?: Record<string, unknown>;
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
    this.apiUrl = process.env.NEXT_PUBLIC_WIDGET_API_URL || 'http://localhost:8787';
  }

  /**
   * Configure the client with widget ID
   */
  configure(config: { widgetId: string; customerId?: string }) {
    this.widgetId = config.widgetId;
    if (config.customerId) {
      this.customerId = config.customerId;
    }
  }

  /**
   * Set the widget ID for API calls
   */
  setWidgetId(widgetId: string) {
    this.widgetId = widgetId;
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
   * Base fetch method with error handling
   */
  private async fetch<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<ApiResponse<T>> {
    try {
      const url = `${this.apiUrl}${endpoint}`;
      console.log(`[Widget API] ${options?.method || 'GET'} ${url}`);

      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...options?.headers,
        },
      });

      if (!response.ok) {
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
      console.error('[Widget API] Network error:', error);
      return {
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : 'Network request failed',
          details: error,
        },
      };
    }
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

    const result = await this.fetch<any>('/api/config');

    // Restore previous widget ID
    this.widgetId = prevWidgetId;

    if (!result.success) {
      return result as ApiResponse<WidgetSettings>;
    }

    // Transform widget API response to WidgetSettings format
    const config = result.data;
    const settings: WidgetSettings = {
      id: config.widgetId || id,
      name: config.widgetName || 'Widget',
      themeSettings: {
        colorPrimary: config.colors?.primary || '#4169E1',
        colorButton: config.colors?.button || '#4169E1',
        colorButtonText: config.colors?.buttonText || '#FFFFFF',
        colorLauncher: config.colors?.launcher || '#000000',
        colorHeader: config.colors?.header || '#FFFFFF',
        colorAccent: config.colors?.accent || '#4169E1',
        borderRadius: parseInt(config.styling?.borderRadius) || 20,
        fontSize: parseInt(config.styling?.fontSize) || 14,
        typographyText: config.styling?.typographyText || '#000000',
        typographyBackground: config.styling?.typographyBackground || '#FFFFFF',
      },
      pageHome: config.pages?.home ?? true,
      pageChat: config.pages?.chat ?? true,
      pageHelp: config.pages?.help ?? true,
      pageParcelTracking: config.pages?.parcelTracking ?? false,
      pageChangelog: config.pages?.changelog ?? false,
      pageNews: config.pages?.news ?? false,
      pageFeedback: config.pages?.feedback ?? false,
      pageAnnouncements: config.pages?.announcements ?? false,
      pageEventSignUp: config.pages?.eventSignUp ?? false,
      typographyText: config.styling?.typographyText || '#000000',
      typographyBackground: config.styling?.typographyBackground || '#FFFFFF',
      startingPage: config.behavior?.startingPage || 'Home',
      position: config.behavior?.position || 'bottom-right',
      autoOpen: config.behavior?.autoOpen ?? false,
      showWelcomeMessage: config.behavior?.showWelcomeMessage ?? true,
      welcomeMessage: config.behavior?.welcomeMessage || 'Hi! How can we help you today?',
      companyLogoUrl: config.branding?.companyLogoUrl,
      // Chat colors
      chatBackgroundColor: config.chat?.backgroundColor,
      userBubbleColor: config.chat?.userBubbleColor,
      userBubbleTextColor: config.chat?.userBubbleTextColor,
      agentBubbleColor: config.chat?.agentBubbleColor,
      agentBubbleTextColor: config.chat?.agentBubbleTextColor,
      // AI settings
      enableAi: config.enableAi ?? false,
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
      showWelcomeMessage: true,
      welcomeMessage: 'Hi! How can we help you today?',
      enableAi: false,
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
    conversation?: { id: string; conversationNumber: string; status: string; createdAt: string; customerId?: string };
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
      };
    }

    const result = await this.fetch<any>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: params.subject || 'New conversation',
        customerEmail: params.customerEmail,
        customerName: params.customerName,
        customerId: params.customerId || this.customerId,
        initialMessage: params.initialMessage,
      }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to create conversation' };
    }

    // Store the customerId for future requests
    if (result.data?.customerId) {
      this.customerId = result.data.customerId;
    }

    return {
      success: true,
      conversation: result.data,
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
    const result = await this.fetch<any>(`/api/conversations/${conversationId}`);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get conversation' };
    }

    return {
      success: true,
      conversation: result.data,
    };
  }

  /**
   * Get customer's conversations
   * Uses Widget API: GET /api/conversations/customer/:customerId
   */
  async getConversations(params: {
    customerEmail?: string;
    customerId?: string;
  }): Promise<{
    success: boolean;
    conversations?: Conversation[];
    error?: string;
  }> {
    if (this._testMode) {
      return { success: true, conversations: [] };
    }

    const customerId = params.customerId || this.customerId;

    if (!customerId) {
      return { success: false, error: 'Customer ID is required', conversations: [] };
    }

    const result = await this.fetch<any>(`/api/conversations/customer/${customerId}`);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get conversations', conversations: [] };
    }

    return {
      success: true,
      conversations: result.data || [],
    };
  }

  /**
   * Close a conversation
   * Uses Widget API: PATCH /api/conversations/:id
   */
  async closeConversation(conversationId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const result = await this.fetch<any>(`/api/conversations/${conversationId}`, {
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

    const result = await this.fetch<any>(`/api/conversations/${conversationId}/typing`, {
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
    const result = await this.fetch<any>(`/api/conversations/${conversationId}/rate`, {
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

    const result = await this.fetch<any>(`/api/messages/${conversationId}`);

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

    const result = await this.fetch<any>(`/api/messages/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: params.content,
        customerId: this.customerId,
        customerName: params.authorName,
        customerEmail: params.authorEmail,
        attachments: params.attachments,
      }),
    });

    console.log('[Widget API] sendMessage response:', result);

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to send message' };
    }

    return {
      success: true,
      message: result.data,
    };
  }

  // ============================================
  // Agents
  // ============================================

  /**
   * Check if agents are online
   * Uses Widget API: GET /api/agents/status
   */
  async checkAgentsOnline(): Promise<AgentOnlineResponse> {
    const result = await this.fetch<any>('/api/agents/status');

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
      console.log(`[Widget API] Uploading ${file.name}...`);

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
      console.log(`[Widget API] Successfully uploaded ${file.name}`);

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
  // Real-time (@weldsuite/realtime)
  // ============================================

  /**
   * Get realtime token for real-time communication
   * Uses Widget API: POST /api/realtime/token
   */
  async getRealtimeToken(conversationId?: string): Promise<{
    success: boolean;
    token?: unknown;
    error?: string;
  }> {
    if (this._testMode) {
      return { success: false, error: 'Test mode — real-time disabled' };
    }

    if (!conversationId || !this.customerId) {
      return { success: false, error: 'Conversation ID and customer ID are required' };
    }

    const result = await this.fetch<any>('/api/realtime/token', {
      method: 'POST',
      body: JSON.stringify({
        customerId: this.customerId,
        conversationId,
      }),
    });

    if (!result.success) {
      return { success: false, error: result.error?.message || 'Failed to get realtime token' };
    }

    return { success: true, token: result.data };
  }

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
  async getConversationHistory(conversationId: string, widgetId?: string): Promise<ApiResponse<any[]>> {
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
      data: result.data as any,
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
export const widgetApiClient = new WidgetApiClient();

// Also export as platformApi for backward compatibility
export const platformApi = widgetApiClient;

// Export class for testing
export { WidgetApiClient };
