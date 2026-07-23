/**
 * Weld SDK - Message Types
 * Type definitions for postMessage communication between parent and iframes
 */

/**
 * Message origins for validation
 */
export enum MessageOrigin {
  LAUNCHER = 'launcher',
  WIDGET = 'widget',
  PARENT = 'parent',
  BACKDROP = 'backdrop',
}

/**
 * Message types for different communication patterns
 */
export enum MessageType {
  // Lifecycle
  READY = 'weld:ready',
  INIT = 'weld:init',
  DESTROY = 'weld:destroy',

  // State changes
  STATE_UPDATE = 'weld:state:update',
  STATE_REQUEST = 'weld:state:request',
  STATE_RESPONSE = 'weld:state:response',

  // Widget control
  WIDGET_OPEN = 'weld:widget:open',
  WIDGET_CLOSE = 'weld:widget:close',
  WIDGET_TOGGLE = 'weld:widget:toggle',
  WIDGET_MINIMIZE = 'weld:widget:minimize',
  WIDGET_MAXIMIZE = 'weld:widget:maximize',

  // Launcher control
  LAUNCHER_SHOW = 'weld:launcher:show',
  LAUNCHER_HIDE = 'weld:launcher:hide',
  LAUNCHER_UPDATE = 'weld:launcher:update',

  // Backdrop control
  BACKDROP_SHOW = 'weld:backdrop:show',
  BACKDROP_HIDE = 'weld:backdrop:hide',
  BACKDROP_CLICK = 'weld:backdrop:click',

  // User interactions
  MESSAGE_SEND = 'weld:message:send',
  MESSAGE_RECEIVE = 'weld:message:receive',
  TYPING_START = 'weld:typing:start',
  TYPING_STOP = 'weld:typing:stop',

  // Badge updates
  BADGE_UPDATE = 'weld:badge:update',
  BADGE_CLEAR = 'weld:badge:clear',

  // Mobile handling
  MOBILE_SCROLL_LOCK = 'weld:mobile:scroll:lock',
  MOBILE_SCROLL_UNLOCK = 'weld:mobile:scroll:unlock',

  // Configuration
  CONFIG_UPDATE = 'weld:config:update',
  THEME_UPDATE = 'weld:theme:update',
  LOCALE_UPDATE = 'weld:locale:update',

  // Authentication
  AUTH_LOGIN = 'weld:auth:login',
  AUTH_LOGOUT = 'weld:auth:logout',
  AUTH_TOKEN_UPDATE = 'weld:auth:token:update',

  // Events
  EVENT_TRACK = 'weld:event:track',
  ERROR_REPORT = 'weld:error:report',

  // Page tracking
  PAGE_CHANGE = 'weld:page:change',

  // API responses
  API_SUCCESS = 'weld:api:success',
  API_ERROR = 'weld:api:error',
}

/**
 * Base message structure
 */
export interface BaseMessage {
  type: MessageType;
  origin: MessageOrigin;
  timestamp: number;
  id: string;
}

/**
 * Message with payload
 */
export interface PayloadMessage<T = any> extends BaseMessage {
  payload: T;
}

/**
 * State update payload
 */
export interface StateUpdatePayload {
  path: string;
  value: any;
  merge?: boolean;
}

/**
 * Widget state payload
 */
export interface WidgetStatePayload {
  isOpen: boolean;
  isMinimized: boolean;
  view?: string;
  data?: any;
}

/**
 * Launcher state payload
 */
export interface LauncherStatePayload {
  isVisible: boolean;
  badgeCount?: number;
  badgeText?: string;
  customColor?: string;
}

/**
 * Backdrop state payload
 */
export interface BackdropStatePayload {
  isVisible: boolean;
  onClick?: 'close' | 'ignore';
}

/**
 * Message data payload
 */
export interface MessageDataPayload {
  id: string;
  text: string;
  sender: 'user' | 'agent' | 'bot';
  timestamp: number;
  attachments?: Array<{
    type: string;
    url: string;
    name?: string;
  }>;
}

/**
 * Configuration update payload
 */
export interface ConfigUpdatePayload {
  apiKey?: string;
  workspaceId?: string;
  position?: {
    launcher?: { bottom: string; right: string };
    widget?: { bottom: string; right: string };
  };
}

/**
 * Theme update payload
 */
export interface ThemeUpdatePayload {
  mode: 'light' | 'dark' | 'auto';
  primaryColor?: string;
  accentColor?: string;
  customCSS?: string;
}

/**
 * Authentication payload
 */
export interface AuthPayload {
  userId?: string;
  email?: string;
  name?: string;
  avatar?: string;
  metadata?: Record<string, any>;
  token?: string;
}

/**
 * Error payload
 */
export interface ErrorPayload {
  code: string;
  message: string;
  stack?: string;
  context?: Record<string, any>;
}

/**
 * Event tracking payload
 */
export interface EventPayload {
  name: string;
  properties?: Record<string, any>;
  timestamp: number;
}

/**
 * Page change payload
 */
export interface PageChangePayload {
  url: string;
  title: string;
  timestamp: number;
}

/**
 * Type guards
 */
export function isBaseMessage(message: any): message is BaseMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'origin' in message &&
    'timestamp' in message &&
    'id' in message
  );
}

export function isPayloadMessage<T = any>(
  message: any
): message is PayloadMessage<T> {
  return isBaseMessage(message) && 'payload' in message;
}

/**
 * Message creator utilities
 */
export function createMessage(
  type: MessageType,
  origin: MessageOrigin,
  payload?: any
): PayloadMessage {
  return {
    type,
    origin,
    timestamp: Date.now(),
    id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    payload,
  };
}

/**
 * Specific message type definitions
 */
export type ReadyMessage = PayloadMessage<{ iframe: string; ready: true }>;
export type StateUpdateMessage = PayloadMessage<StateUpdatePayload>;
export type WidgetStateMessage = PayloadMessage<WidgetStatePayload>;
export type LauncherStateMessage = PayloadMessage<LauncherStatePayload>;
export type BackdropStateMessage = PayloadMessage<BackdropStatePayload>;
export type MessageDataMessage = PayloadMessage<MessageDataPayload>;
export type ConfigUpdateMessage = PayloadMessage<ConfigUpdatePayload>;
export type ThemeUpdateMessage = PayloadMessage<ThemeUpdatePayload>;
export type AuthMessage = PayloadMessage<AuthPayload>;
export type ErrorMessage = PayloadMessage<ErrorPayload>;
export type EventMessage = PayloadMessage<EventPayload>;
export type PageChangeMessage = PayloadMessage<PageChangePayload>;

/**
 * Union type for all messages
 */
export type WeldMessage =
  | BaseMessage
  | ReadyMessage
  | StateUpdateMessage
  | WidgetStateMessage
  | LauncherStateMessage
  | BackdropStateMessage
  | MessageDataMessage
  | ConfigUpdateMessage
  | ThemeUpdateMessage
  | AuthMessage
  | ErrorMessage
  | EventMessage
  | PageChangeMessage;
