/**
 * Weld SDK - Main Export
 * Multi-iframe architecture for helpdesk widget
 * Version 2.0.0
 */

// Core modules
export { WeldSDK, createWeldSDK, destroyWeldSDK } from './core/WeldSDK';
export { IframeManager, IframeType } from './core/IframeManager';
export { MessageBroker } from './core/MessageBroker';
export { StateCoordinator } from './core/StateCoordinator';

// Convenience aliases for backward compatibility with README documentation
export { WeldSDK as HelpdeskWidget } from './core/WeldSDK';
export { createWeldSDK as initHelpdeskWidget } from './core/WeldSDK';
export { destroyWeldSDK as destroyHelpdeskWidget } from './core/WeldSDK';

// Type definitions
export type {
  // Configuration types
  WeldConfig,
  WeldConfig as HelpdeskWidgetConfig, // Alias for backward compatibility
  ResolvedConfig,
  PositionConfig,
  IframeConfig,
  ApiConfig,
  AuthConfig,
  LocaleConfig,
  LogConfig,
  PerformanceConfig,
  SecurityConfig,
  DeviceType,
  DeviceInfo,
  // Event types
  WidgetEventType,
  WidgetEvent,
  WidgetEventHandler,
} from './types/config';

export type {
  // Message types
  MessageOrigin,
  MessageType,
  BaseMessage,
  PayloadMessage,
  StateUpdatePayload,
  WidgetStatePayload,
  LauncherStatePayload,
  BackdropStatePayload,
  MessageDataPayload,
  ConfigUpdatePayload,
  ThemeUpdatePayload,
  AuthPayload,
  ErrorPayload,
  EventPayload,
  WeldMessage,
} from './types/messages';

export type {
  // State types
  WeldState,
  WidgetVisibility,
  WidgetView,
  ConnectionStatus,
  MessageStatus,
  UserState,
  ConversationState,
  Message,
  Attachment,
  Reaction,
  Participant,
  WidgetState,
  LauncherState,
  BackdropState,
  MobileState,
  NetworkState,
  UIState,
  StateAction,
  StateListener,
  StateSubscription,
} from './types/state';

// Utilities
export { Logger, LogLevel, defaultLogger } from './utils/logger';
export {
  SecurityManager,
  RateLimiter,
  TokenValidator,
} from './utils/security';
export {
  isValidEmail,
  isValidUrl,
  isValidApiKey,
  isValidWorkspaceId,
  isValidColor,
  isValidMessageText,
  sanitizeHtml,
  sanitizeInput,
  hasRequiredProperties,
  isValidLength,
  isInRange,
  isValidArrayLength,
  deepClone,
  isPlainObject,
  deepMerge,
  isValidFileType,
  isValidFileSize,
  formatFileSize,
} from './utils/validation';

// Message creators
export { createMessage, isBaseMessage, isPayloadMessage } from './types/messages';

// State utilities
export { createInitialState, getStateValue, setStateValue } from './types/state';

// Configuration utilities
export { validateConfig, resolveConfig, DEFAULT_CONFIG } from './types/config';

// Default export
export { WeldSDK as default } from './core/WeldSDK';

/**
 * Quick start example:
 *
 * ```typescript
 * import { createWeldSDK } from '@weldsuite/helpdesk-widget-sdk';
 *
 * const weld = await createWeldSDK({
 *   apiKey: 'your-api-key',
 *   workspaceId: 'your-workspace-id',
 *   onReady: () => console.log('Widget ready!'),
 *   onOpen: () => console.log('Widget opened'),
 *   onClose: () => console.log('Widget closed'),
 * });
 *
 * // Open the widget
 * weld.open();
 *
 * // Send a message
 * weld.sendMessage('Hello from parent!');
 *
 * // Identify user
 * weld.identify({
 *   userId: '123',
 *   email: 'user@example.com',
 *   name: 'John Doe',
 * });
 *
 * // Listen to state changes
 * weld.onStateChange('widget.isOpen', (isOpen) => {
 *   console.log('Widget is now:', isOpen ? 'open' : 'closed');
 * });
 * ```
 */
