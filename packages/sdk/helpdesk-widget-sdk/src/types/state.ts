/**
 * Weld SDK - State Types
 * Type definitions for state management across iframes
 */

/**
 * Widget visibility state
 */
export enum WidgetVisibility {
  HIDDEN = 'hidden',
  VISIBLE = 'visible',
  MINIMIZED = 'minimized',
}

/**
 * Widget view types
 */
export enum WidgetView {
  HOME = 'home',
  CONVERSATION = 'conversation',
  CONVERSATIONS = 'conversations',
  HELP = 'help',
  SETTINGS = 'settings',
  SEARCH = 'search',
}

/**
 * Connection status
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

/**
 * Message status
 */
export enum MessageStatus {
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

/**
 * User state
 */
export interface UserState {
  id?: string;
  email?: string;
  name?: string;
  avatar?: string;
  metadata?: Record<string, any>;
  isAuthenticated: boolean;
  isAnonymous: boolean;
}

/**
 * Conversation state
 */
export interface ConversationState {
  id?: string;
  messages: Message[];
  participants: Participant[];
  unreadCount: number;
  lastMessageAt?: number;
  isTyping: boolean;
  typingUsers: string[];
}

/**
 * Message interface
 */
export interface Message {
  id: string;
  conversationId: string;
  text: string;
  sender: {
    id: string;
    name: string;
    avatar?: string;
    type: 'user' | 'agent' | 'bot';
  };
  status: MessageStatus;
  timestamp: number;
  createdAt: number;
  updatedAt?: number;
  attachments?: Attachment[];
  reactions?: Reaction[];
  metadata?: Record<string, any>;
}

/**
 * Attachment interface
 */
export interface Attachment {
  id: string;
  type: 'image' | 'file' | 'video' | 'audio';
  url: string;
  name: string;
  size: number;
  mimeType: string;
  thumbnail?: string;
}

/**
 * Reaction interface
 */
export interface Reaction {
  emoji: string;
  count: number;
  users: string[];
}

/**
 * Participant interface
 */
export interface Participant {
  id: string;
  name: string;
  avatar?: string;
  type: 'user' | 'agent' | 'bot';
  isOnline: boolean;
  lastSeenAt?: number;
}

/**
 * Widget state
 */
export interface WidgetState {
  visibility: WidgetVisibility;
  view: WidgetView;
  isOpen: boolean;
  isMinimized: boolean;
  dimensions: {
    width: string;
    height: string;
  };
  position: {
    bottom: string;
    right: string;
  };
}

/**
 * Launcher state
 */
export interface LauncherState {
  isVisible: boolean;
  badge: {
    count: number;
    text?: string;
    show: boolean;
  };
  customColor?: string;
  tooltip?: string;
}

/**
 * Backdrop state
 */
export interface BackdropState {
  isVisible: boolean;
  closeOnClick: boolean;
  opacity: number;
}

/**
 * Mobile state
 */
export interface MobileState {
  isFullScreen: boolean;
  isScrollLocked: boolean;
  keyboardHeight: number;
  orientation: 'portrait' | 'landscape';
  safeAreaInsets: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

/**
 * Network state
 */
export interface NetworkState {
  status: ConnectionStatus;
  lastConnected?: number;
  retryCount: number;
  latency?: number;
}

/**
 * UI state
 */
export interface UIState {
  theme: 'light' | 'dark' | 'auto';
  locale: string;
  isLoading: boolean;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/**
 * Main application state
 */
export interface WeldState {
  user: UserState;
  conversation: ConversationState;
  widget: WidgetState;
  launcher: LauncherState;
  backdrop: BackdropState;
  mobile: MobileState;
  network: NetworkState;
  ui: UIState;
  initialized: boolean;
  lastUpdated: number;
}

/**
 * State update action
 */
export interface StateAction<T = any> {
  type: string;
  path: keyof WeldState | string;
  payload: T;
  merge?: boolean;
  timestamp: number;
}

/**
 * State listener callback
 */
export type StateListener<T = any> = (newState: T, oldState: T) => void;

/**
 * State subscription
 */
export interface StateSubscription {
  id: string;
  path: string;
  listener: StateListener;
  immediate?: boolean;
}

/**
 * Initial state factory
 */
export function createInitialState(): WeldState {
  return {
    user: {
      isAuthenticated: false,
      isAnonymous: true,
    },
    conversation: {
      messages: [],
      participants: [],
      unreadCount: 0,
      isTyping: false,
      typingUsers: [],
    },
    widget: {
      visibility: WidgetVisibility.HIDDEN,
      view: WidgetView.HOME,
      isOpen: false,
      isMinimized: false,
      dimensions: {
        width: '400px',
        height: 'min(680px, 88vh)',
      },
      position: {
        bottom: '24px',
        right: '24px',
      },
    },
    launcher: {
      isVisible: true,
      badge: {
        count: 0,
        show: false,
      },
    },
    backdrop: {
      isVisible: false,
      closeOnClick: true,
      opacity: 0,
    },
    mobile: {
      isFullScreen: false,
      isScrollLocked: false,
      keyboardHeight: 0,
      orientation: 'portrait',
      safeAreaInsets: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
    },
    network: {
      status: ConnectionStatus.DISCONNECTED,
      retryCount: 0,
    },
    ui: {
      theme: 'auto',
      locale: 'en',
      isLoading: false,
    },
    initialized: false,
    lastUpdated: Date.now(),
  };
}

/**
 * State path utility
 */
export function getStateValue<T = any>(state: WeldState, path: string): T {
  const keys = path.split('.');
  let value: any = state;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return undefined as T;
    }
  }

  return value as T;
}

/**
 * State update utility
 */
export function setStateValue(
  state: WeldState,
  path: string,
  value: any,
  merge = false
): WeldState {
  const keys = path.split('.');
  const newState = JSON.parse(JSON.stringify(state));
  let current: any = newState;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key];
  }

  const lastKey = keys[keys.length - 1];

  if (merge && typeof current[lastKey] === 'object' && typeof value === 'object') {
    current[lastKey] = { ...current[lastKey], ...value };
  } else {
    current[lastKey] = value;
  }

  newState.lastUpdated = Date.now();
  return newState;
}
