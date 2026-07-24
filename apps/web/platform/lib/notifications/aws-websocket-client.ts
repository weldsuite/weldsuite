/**
 * AWS API Gateway WebSocket Client for Email Notifications
 * Manages WebSocket connection to AWS API Gateway for real-time email notifications
 */

import type { ConnectionStatus, NotificationHandler, NotificationMessage } from './types';

export interface AwsWebSocketConfig {
  endpoint: string;
  reconnectDelays?: number[];
}

export class AwsWebSocketClient {
  private ws: WebSocket | null = null;
  private config: AwsWebSocketConfig;
  private userId: string | null = null;
  private reconnectAttempt: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private listeners: Set<NotificationHandler> = new Set();
  private typedListeners: Map<string, Set<NotificationHandler>> = new Map();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private currentStatus: ConnectionStatus = 'disconnected';
  private subscribedEmailAccounts: Set<string> = new Set();

  constructor(config: AwsWebSocketConfig) {
    this.config = {
      endpoint: config.endpoint,
      reconnectDelays: config.reconnectDelays ?? [0, 1000, 2000, 5000, 10000, 30000],
    };
  }

  /**
   * Connect to the WebSocket API
   */
  async connect(userId: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.warn('[AwsWebSocket] Already connected');
      return;
    }

    this.userId = userId;
    this.updateStatus('connecting');

    return new Promise((resolve, reject) => {
      try {
        const url = `${this.config.endpoint}?userId=${encodeURIComponent(userId)}`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.reconnectAttempt = 0;
          this.updateStatus('connected');

          // Re-subscribe to email accounts after reconnection
          for (const accountId of this.subscribedEmailAccounts) {
            this.subscribeToEmailAccountInternal(accountId);
          }

          resolve();
        };

        this.ws.onclose = () => {
          this.updateStatus('disconnected');
          this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[AwsWebSocket] Connection error:', error);
          this.updateStatus('error');
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        console.error('[AwsWebSocket] Failed to connect:', error);
        this.updateStatus('error');
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.updateStatus('disconnected');
  }

  /**
   * Subscribe to email account notifications
   */
  async subscribeToEmailAccount(emailAccountId: string): Promise<void> {
    this.subscribedEmailAccounts.add(emailAccountId);

    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.subscribeToEmailAccountInternal(emailAccountId);
    }
  }

  private async subscribeToEmailAccountInternal(emailAccountId: string): Promise<void> {
    try {
      this.ws?.send(JSON.stringify({
        action: 'subscribe',
        emailAccountId,
      }));
    } catch (error) {
      console.error('[AwsWebSocket] Failed to subscribe:', error);
    }
  }

  /**
   * Unsubscribe from email account notifications
   */
  async unsubscribeFromEmailAccount(emailAccountId: string): Promise<void> {
    this.subscribedEmailAccounts.delete(emailAccountId);

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          action: 'unsubscribe',
          emailAccountId,
        }));
      } catch (error) {
        console.error('[AwsWebSocket] Failed to unsubscribe:', error);
      }
    }
  }

  /**
   * Subscribe to all notifications
   */
  subscribe(handler: NotificationHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Subscribe to specific notification type
   */
  subscribeToType(type: string, handler: NotificationHandler): () => void {
    if (!this.typedListeners.has(type)) {
      this.typedListeners.set(type, new Set());
    }
    this.typedListeners.get(type)!.add(handler);

    return () => {
      const handlers = this.typedListeners.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.typedListeners.delete(type);
        }
      }
    };
  }

  /**
   * Subscribe to connection status changes
   */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.currentStatus;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: string): void {
    try {
      const message: NotificationMessage = JSON.parse(data);

      // Notify all general listeners
      this.listeners.forEach((listener) => {
        try {
          listener(message);
        } catch (error) {
          console.error('[AwsWebSocket] Error in notification handler:', error);
        }
      });

      // Notify type-specific listeners
      if (message.type) {
        const handlers = this.typedListeners.get(message.type);
        if (handlers) {
          handlers.forEach((handler) => {
            try {
              handler(message);
            } catch (error) {
              console.error(`[AwsWebSocket] Error in ${message.type} handler:`, error);
            }
          });
        }
      }
    } catch (error) {
      console.error('[AwsWebSocket] Error parsing message:', error, data);
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.statusListeners.forEach((listener) => {
        try {
          listener(status);
        } catch (error) {
          console.error('[AwsWebSocket] Error in status listener:', error);
        }
      });
    }
  }

  private scheduleReconnect(): void {
    if (!this.userId) return;

    const delays = this.config.reconnectDelays!;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempt++;
      this.connect(this.userId!).catch((error) => {
        console.error('[AwsWebSocket] Reconnect failed:', error);
      });
    }, delay);
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.disconnect();
    this.listeners.clear();
    this.typedListeners.clear();
    this.statusListeners.clear();
    this.subscribedEmailAccounts.clear();
  }
}
