export interface WidgetSettings {
  id: string;
  name: string;
  themeSettings: ThemeSettings;
  // Individual page flags
  pageHome: boolean;
  pageChat: boolean;
  pageHelp: boolean;
  pageParcelTracking: boolean;
  pageChangelog: boolean;
  pageNews: boolean;
  pageFeedback: boolean;
  pageAnnouncements: boolean;
  pageEventSignUp: boolean;
  // Typography at root level
  typographyText: string;
  typographyBackground: string;
  // Widget behavior settings
  startingPage: string;
  position: string;
  autoOpen: boolean;
  // Branding
  companyLogoUrl?: string;
  showBranding?: boolean;
  // Chat interface colors
  chatBackgroundColor?: string;
  userBubbleColor?: string;
  userBubbleTextColor?: string;
  agentBubbleColor?: string;
  agentBubbleTextColor?: string;
  // Optional fields that may not be in all responses
  organizationId?: string;
  workspaceId?: string;
  disableBackNavigation?: boolean;
  // Availability
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
  nextOpenTime?: string | null;
  officeHoursTimezone?: string | null;
  officeHours?: Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }> | null;
  // Welcome workflow steps from config API (conversation:created trigger)
  welcomeFlow?: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    config: Record<string, unknown>;
  }> | null;
  // Bot agent info from WeldAgent settings (name + logo for widget header)
  botAgent?: { name: string; avatarUrl: string | null } | null;
}

export interface ThemeSettings {
  colorPrimary: string;
  colorButton: string;
  colorButtonText: string;
  colorLauncher: string;
  colorHeader: string;
  colorAccent: string;
  borderRadius: number;
  fontSize: number;
  typographyText: string;
  typographyBackground: string;
}

export interface PageConfig {
  id: string;
  name: string;
  icon: string;
  label: string;
  enabled: boolean;
  order: number;
  customSettings?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface MessageAttachment {
  id: string;
  name?: string;
  fileName?: string;
  size?: string;
  fileSize?: number;
  mimeType?: string;
  type?: 'image' | 'file';
  url?: string;
}

/**
 * Parameters for sending a message
 */
export interface SendMessageParams {
  content: string;
  authorName?: string;
  authorEmail?: string;
  attachments?: MessageAttachment[];
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

export interface Conversation {
  id: string;
  widgetId: string;
  customerName?: string;
  customerEmail?: string;
  status: 'active' | 'closed' | 'pending';
  createdAt: Date;
  updatedAt: Date;
  assignedAgentId?: string;
  assignedAgentName?: string;
}

export interface CreateConversationRequest {
  widgetId: string;
  customerName?: string;
  customerEmail?: string;
  initialMessage?: string;
}

export interface SendMessageRequest {
  conversationId: string;
  widgetId: string;
  content: string;
  sender: 'user' | 'agent';
}

// =============================================================================
// Customer API Types
// =============================================================================

export interface StartConversationRequest {
  name: string;
  email: string;
  subject?: string;
  message?: string;
  phone?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartConversationResponse {
  success: boolean;
  data?: {
    id: string;
    conversationNumber?: number;
    subject?: string;
    status: string;
    priority: string;
    channel: string;
    customerId?: string;
    createdAt: string;
    messages?: ConversationMessage[];
  };
  error?: ApiError;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  content: string;
  htmlContent?: string;
  type: 'message' | 'note' | 'system';
  isInternal: boolean;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  userId?: string;
  userName?: string;
  userAvatar?: string;
  contactId?: string;
  contactName?: string;
  createdAt: string;
}

export interface ConversationResponse {
  success: boolean;
  data?: {
    id: string;
    conversationNumber?: number;
    subject?: string;
    status: string;
    priority: string;
    channel: string;
    customerId?: string;
    customerName?: string;
    customerEmail?: string;
    assignedAgentId?: string;
    assignedAgentName?: string;
    assignedAgentAvatar?: string;
    isRead: boolean;
    createdAt: string;
    updatedAt?: string;
    firstResponseAt?: string;
    closedAt?: string;
    messages: ConversationMessage[];
  };
  error?: ApiError;
}

export interface SendCustomerMessageRequest {
  content: string;
  htmlContent?: string;
  attachments?: string[];
}

export interface SendCustomerMessageResponse {
  success: boolean;
  data?: ConversationMessage;
  error?: ApiError;
}

export interface WidgetConfigResponse {
  success: boolean;
  data?: {
    name: string;
    enabled: boolean;
    settings: WidgetSettings;
  };
  error?: ApiError;
}

// =============================================================================
// Open Endpoint Types (single-request widget initialization)
// =============================================================================

export interface OpenRequest {
  visitorId?: string;
  email?: string;
  customerName?: string;
  url?: string;
}

export interface OpenWelcomeWorkflow {
  workflowId: string;
  parts: Array<{
    stepId: string;
    type: 'send_message' | 'send_choices' | 'delay' | 'collect_input' | 'collect_customer_info';
    message: string;
    options?: Array<{ id: string; label: string; value: string }>;
    /** Form fields for collect_input steps */
    fields?: Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }>;
    /** Delay duration in seconds (only for type: 'delay') */
    delaySeconds?: number;
  }>;
  bot: {
    name: string;
    avatarUrl: string | null;
    isBot: boolean;
  };
}

export interface OpenTeam {
  agents: Array<{
    id: string;
    name: string;
    avatar: string | null;
    isOnline: boolean;
  }>;
  onlineCount: number;
}

export interface OpenContact {
  contactId: string;
  email: string | null;
  name: string | null;
}

export interface OpenConversation {
  id: string;
  conversationNumber: string | null;
  subject: string | null;
  status: string | null;
  preview: string | null;
  messageCount: number | null;
  unreadCount: number | null;
  lastMessageAt: string | null;
  assigneeName: string | null;
  assigneeAvatar: string | null;
  createdAt: string | null;
}

export interface OpenResponse {
  config: Record<string, unknown>;
  welcomeWorkflow: OpenWelcomeWorkflow | null;
  team: OpenTeam;
  contact: OpenContact | null;
  conversations: OpenConversation[];
  unreadCount: number;
}

/** Welcome message returned inline from POST /api/conversations (Intercom pattern) */
export interface InlineWelcomeMessage {
  id: string;
  conversationId: string;
  content: string;
  authorType: string;
  authorName: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOnlineResponse {
  success: boolean;
  data?: {
    online: boolean;
    agentCount?: number;
    agents?: AgentInfo[];
  };
  error?: ApiError;
}

export interface AgentInfo {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  status: 'online' | 'busy' | 'away' | 'offline';
  availableForChats: boolean;
}

export interface RateConversationRequest {
  rating: number; // 1-5
  comment?: string;
}

export interface RateConversationResponse {
  success: boolean;
  data?: {
    rated: boolean;
  };
  error?: ApiError;
}
