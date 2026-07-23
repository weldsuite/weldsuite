/**
 * Weld SDK - Message Broker
 * Handles secure postMessage communication between parent and iframes
 */

import type {
  WeldMessage,
  MessageType,
  PayloadMessage,
} from '../types/messages';
import {
  MessageOrigin,
  isBaseMessage,
  isPayloadMessage,
  createMessage,
} from '../types/messages';
import type { ResolvedConfig } from '../types/config';
import { Logger } from '../utils/logger';
import { SecurityManager, RateLimiter } from '../utils/security';
import { IframeManager, IframeType } from './IframeManager';

/**
 * Message handler callback
 */
export type MessageHandler<T = any> = (payload: T, message: PayloadMessage<T>) => void;

/**
 * Message subscription
 */
interface MessageSubscription {
  id: string;
  type: MessageType | '*';
  origin?: MessageOrigin;
  handler: MessageHandler;
}

/**
 * Queued message with metadata
 */
interface QueuedMessage {
  message: PayloadMessage;
  queuedAt: number;
  targetIframe: IframeType;
}

/**
 * Iframe ready state tracking
 */
interface IframeReadyState {
  domLoaded: boolean;       // iframe.onload fired
  jsReady: boolean;         // weld:ready received
  initSent: boolean;        // weld:init sent
}

/**
 * MessageBroker class
 * Central hub for all postMessage communication
 */
export class MessageBroker {
  private config: ResolvedConfig;
  private logger: Logger;
  private security: SecurityManager;
  private iframeManager: IframeManager;
  private subscriptions: Map<string, MessageSubscription> = new Map();
  private messageQueue: QueuedMessage[] = [];
  private isReady = false;
  private rateLimiter: RateLimiter;
  private responseHandlers: Map<string, (message: WeldMessage) => void> = new Map();

  // Iframe ready state tracking
  private iframeReadyStates: Map<IframeType, IframeReadyState> = new Map();

  // Queue timeout configuration
  private queueTimeout = 30000; // 30 seconds
  private queueWatcherInterval: ReturnType<typeof setInterval> | null = null;

  // Bound handlers for proper cleanup
  private boundHandleMessage: (event: MessageEvent) => void;

  constructor(
    config: ResolvedConfig,
    iframeManager: IframeManager,
    logger: Logger
  ) {
    this.config = config;
    this.logger = logger.child('[MessageBroker]');
    this.iframeManager = iframeManager;
    this.security = new SecurityManager(config.security, this.logger);

    // Automatically trust messages from the widget's base URL
    // The iframes load from api.baseUrl, so we must accept their postMessages
    try {
      const widgetOrigin = new URL(config.api.baseUrl).origin;
      this.security.addAllowedOrigin(widgetOrigin);
    } catch {
      // Invalid URL, will rely on configured allowedOrigins
    }

    this.rateLimiter = new RateLimiter(100, 60000); // 100 messages per minute

    // Bind handlers once for proper cleanup
    this.boundHandleMessage = this.handleMessage.bind(this);

    // Initialize ready states
    this.iframeReadyStates.set(IframeType.LAUNCHER, { domLoaded: false, jsReady: false, initSent: false });
    this.iframeReadyStates.set(IframeType.WIDGET, { domLoaded: false, jsReady: false, initSent: false });

    this.setupMessageListener();
    this.startQueueWatcher();
    this.logger.debug('MessageBroker initialized');
  }

  /**
   * Setup global message listener
   */
  private setupMessageListener(): void {
    window.addEventListener('message', this.boundHandleMessage);
    this.logger.debug('Message listener setup');
  }

  /**
   * Start queue watcher to clean up expired messages
   */
  private startQueueWatcher(): void {
    this.queueWatcherInterval = setInterval(() => {
      const now = Date.now();
      const expiredMessages = this.messageQueue.filter(
        item => now - item.queuedAt > this.queueTimeout
      );

      if (expiredMessages.length > 0) {
        this.messageQueue = this.messageQueue.filter(
          item => now - item.queuedAt <= this.queueTimeout
        );
        for (const item of expiredMessages) {
          this.logger.warn('Message expired in queue', {
            type: item.message.type,
            targetIframe: item.targetIframe,
            queuedFor: now - item.queuedAt,
          });
        }
      }
    }, 5000);
  }

  /**
   * Get target origin for postMessage (security improvement)
   */
  private getTargetOrigin(): string {
    if (this.config.api?.baseUrl) {
      try {
        return new URL(this.config.api.baseUrl).origin;
      } catch {
        // Invalid URL, fall back to wildcard
      }
    }
    // Fall back to wildcard if no valid baseUrl configured
    return '*';
  }

  /**
   * Handle incoming postMessage
   */
  private handleMessage(event: MessageEvent): void {
    // Validate message event
    if (!this.security.validateMessageEvent(event)) {
      return;
    }

    // Validate message structure
    if (!isBaseMessage(event.data)) {
      this.logger.warn('Invalid message structure', event.data);
      return;
    }

    const message = event.data as WeldMessage;

    // Rate limiting
    if (!this.rateLimiter.isAllowed(message.origin)) {
      this.logger.warn('Rate limit exceeded', { origin: message.origin });
      return;
    }

    // Sanitize message if enabled
    const sanitized = this.config.security.sanitizeInput
      ? this.security.sanitizeMessageData(message)
      : message;

    this.logger.debug('Message received', {
      type: sanitized.type,
      origin: sanitized.origin,
      id: sanitized.id,
    });

    // Check for response handlers
    if (this.responseHandlers.has(sanitized.id)) {
      const handler = this.responseHandlers.get(sanitized.id);
      handler?.(sanitized);
      this.responseHandlers.delete(sanitized.id);
      return;
    }

    // Dispatch to subscribers
    this.dispatchMessage(sanitized);
  }

  /**
   * Dispatch message to subscribers
   */
  private dispatchMessage(message: WeldMessage): void {
    const subscriptions = Array.from(this.subscriptions.values());

    for (const subscription of subscriptions) {
      // Check if type matches
      const typeMatches =
        subscription.type === '*' || subscription.type === message.type;

      // Check if origin matches (if specified)
      const originMatches =
        !subscription.origin || subscription.origin === message.origin;

      if (typeMatches && originMatches) {
        try {
          if (isPayloadMessage(message)) {
            subscription.handler(message.payload, message);
          } else {
            subscription.handler(undefined, message as unknown as PayloadMessage);
          }
        } catch (error) {
          this.logger.error('Error in message handler', error);
        }
      }
    }
  }

  /**
   * Subscribe to messages
   */
  public subscribe<T = any>(
    type: MessageType | '*',
    handler: MessageHandler<T>,
    origin?: MessageOrigin
  ): string {
    const id = this.security.generateSecureId();

    this.subscriptions.set(id, {
      id,
      type,
      origin,
      handler,
    });

    this.logger.debug('Subscribed to messages', { type, origin, id });
    return id;
  }

  /**
   * Unsubscribe from messages
   */
  public unsubscribe(subscriptionId: string): void {
    if (this.subscriptions.delete(subscriptionId)) {
      this.logger.debug('Unsubscribed from messages', { id: subscriptionId });
    }
  }

  /**
   * Send message to iframe
   */
  public sendToIframe(
    iframeType: IframeType,
    type: MessageType,
    payload?: any
  ): void {
    const iframe = this.iframeManager.getIframe(iframeType);

    if (!iframe) {
      this.logger.warn('Iframe not found', { iframeType });
      return;
    }

    // Check if iframe is truly ready (JS ready, not just DOM loaded)
    const readyState = this.iframeReadyStates.get(iframeType);
    const isJsReady = readyState?.jsReady ?? false;

    // Allow weld:init to be sent before JS is ready (it triggers the ready response)
    if (!isJsReady && type !== ('weld:init' as MessageType)) {
      // Queue message if iframe not ready
      const message = createMessage(type, MessageOrigin.PARENT, payload);
      this.messageQueue.push({
        message,
        queuedAt: Date.now(),
        targetIframe: iframeType,
      });
      this.logger.debug('Message queued (iframe JS not ready)', {
        iframeType,
        type,
      });
      return;
    }

    const message = createMessage(type, MessageOrigin.PARENT, payload);
    this.postMessage(iframe.element, message);
  }

  /**
   * Send message to all iframes
   */
  public broadcast(type: MessageType, payload?: any): void {
    const message = createMessage(type, MessageOrigin.PARENT, payload);

    const launcherIframe = this.iframeManager.getIframe(IframeType.LAUNCHER);
    const widgetIframe = this.iframeManager.getIframe(IframeType.WIDGET);
    const launcherReady = this.iframeReadyStates.get(IframeType.LAUNCHER)?.jsReady ?? false;
    const widgetReady = this.iframeReadyStates.get(IframeType.WIDGET)?.jsReady ?? false;

    if (launcherIframe && launcherReady) {
      this.postMessage(launcherIframe.element, message);
    }
    if (widgetIframe && widgetReady) {
      this.postMessage(widgetIframe.element, message);
    }

    this.logger.debug('Message broadcast', { type });
  }

  /**
   * Send message and wait for response
   */
  public async sendAndWaitForResponse<T = any>(
    iframeType: IframeType,
    type: MessageType,
    payload?: any,
    timeout = 5000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const message = createMessage(type, MessageOrigin.PARENT, payload);

      // Setup response handler
      const timeoutId = setTimeout(() => {
        this.responseHandlers.delete(message.id);
        reject(new Error('Message response timeout'));
      }, timeout);

      this.responseHandlers.set(message.id, (response: WeldMessage) => {
        clearTimeout(timeoutId);
        if (isPayloadMessage(response)) {
          resolve(response.payload as T);
        } else {
          resolve(undefined as T);
        }
      });

      // Send message
      const iframe = this.iframeManager.getIframe(iframeType);
      if (!iframe) {
        reject(new Error('Iframe not found'));
        return;
      }

      this.postMessage(iframe.element, message);
    });
  }

  /**
   * Post message to iframe
   */
  private postMessage(iframe: HTMLIFrameElement, message: WeldMessage): void {
    try {
      if (!iframe.contentWindow) {
        this.logger.warn('Iframe contentWindow not available - cross-origin issue?');
        return;
      }

      const targetOrigin = this.getTargetOrigin();
      iframe.contentWindow.postMessage(message, targetOrigin);
      this.logger.debug('Message sent', {
        type: message.type,
        id: message.id,
        targetOrigin,
      });
    } catch (error) {
      this.logger.error('Failed to post message - cross-origin issue?', error);
    }
  }

  /**
   * Mark iframe DOM as loaded (called from onload callback)
   * This triggers sending weld:init to the iframe
   */
  public setIframeDomLoaded(iframeType: IframeType): void {
    const readyState = this.iframeReadyStates.get(iframeType);
    if (readyState) {
      readyState.domLoaded = true;
      this.logger.debug(`Iframe ${iframeType} DOM loaded`);

      // Send weld:init message if not already sent
      if (!readyState.initSent) {
        this.sendInitMessage(iframeType);
        readyState.initSent = true;
      }
    }
  }

  /**
   * Send weld:init message to iframe
   */
  private sendInitMessage(iframeType: IframeType): void {
    const iframe = this.iframeManager.getIframe(iframeType);
    if (!iframe) return;

    const initPayload = {
      widgetId: this.config.widgetId,
      iframeType,
      config: {
        api: this.config.api,
      },
    };

    const message = createMessage('weld:init' as MessageType, MessageOrigin.PARENT, initPayload);
    this.postMessage(iframe.element, message);
    this.logger.debug(`Sent weld:init to ${iframeType}`, initPayload);
  }

  /**
   * Mark iframe JS as ready (called when weld:ready message is received)
   * This flushes queued messages
   */
  public setIframeReady(iframeType: IframeType): void {
    const readyState = this.iframeReadyStates.get(iframeType);
    if (readyState) {
      readyState.jsReady = true;
      this.logger.debug(`Iframe ${iframeType} JS ready`);
    }

    // Also update iframeManager for backwards compatibility
    this.iframeManager.setIframeReady(iframeType);

    // Flush queued messages for this iframe
    this.flushMessageQueue(iframeType);

    // Check if all iframes JS ready
    if (this.areAllIframesJsReady()) {
      this.isReady = true;
      this.logger.info('All iframes JS ready');
    }
  }

  /**
   * Check if all iframes have JS ready
   */
  public areAllIframesJsReady(): boolean {
    const launcherState = this.iframeReadyStates.get(IframeType.LAUNCHER);
    const widgetState = this.iframeReadyStates.get(IframeType.WIDGET);

    // Both launcher and widget must be JS ready
    return (launcherState?.jsReady ?? false) && (widgetState?.jsReady ?? false);
  }

  /**
   * Check if a specific iframe is JS ready
   */
  public isIframeJsReady(iframeType: IframeType): boolean {
    return this.iframeReadyStates.get(iframeType)?.jsReady ?? false;
  }

  /**
   * Flush queued messages to iframe
   */
  private flushMessageQueue(iframeType: IframeType): void {
    const iframe = this.iframeManager.getIframe(iframeType);
    if (!iframe) return;

    // Filter messages for this iframe and remove from queue
    const messagesToFlush = this.messageQueue.filter(
      item => item.targetIframe === iframeType
    );
    this.messageQueue = this.messageQueue.filter(
      item => item.targetIframe !== iframeType
    );

    for (const item of messagesToFlush) {
      this.postMessage(iframe.element, item.message);
    }

    if (messagesToFlush.length > 0) {
      this.logger.debug('Flushed queued messages', {
        count: messagesToFlush.length,
        iframeType,
      });
    }
  }

  /**
   * Check if broker is ready
   */
  public isMessageBrokerReady(): boolean {
    return this.isReady;
  }

  /**
   * Get queued message count
   */
  public getQueuedMessageCount(): number {
    return this.messageQueue.length;
  }

  /**
   * Clear message queue
   */
  public clearMessageQueue(): void {
    this.messageQueue = [];
    this.logger.debug('Message queue cleared');
  }

  /**
   * Get active subscription count
   */
  public getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Destroy broker and cleanup
   */
  public destroy(): void {
    this.logger.debug('Destroying message broker');

    // Remove event listener using bound handler
    window.removeEventListener('message', this.boundHandleMessage);

    // Clear queue watcher
    if (this.queueWatcherInterval) {
      clearInterval(this.queueWatcherInterval);
      this.queueWatcherInterval = null;
    }

    // Clear subscriptions
    this.subscriptions.clear();

    // Clear message queue
    this.messageQueue = [];

    // Clear response handlers
    this.responseHandlers.clear();

    // Reset rate limiter
    this.rateLimiter.clearAll();

    // Reset ready states
    this.iframeReadyStates.clear();

    this.isReady = false;
    this.logger.info('MessageBroker destroyed');
  }
}
